import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationDispatchRejectedError,
  ConversationSteerUnavailableError,
} from "../src/agents/conversation-backend.js";
import { ClaudeConversation, inspectClaudeReadiness } from "../src/claude/conversation.js";
import { claudeChildEnvironment } from "../src/claude/readiness.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function fixture(
  options: {
    authMethod?: string;
    subscription?: string;
    mode?: string;
    permissionMode?: string;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-protocol-"));
  directories.push(directory);
  const executablePath = path.join(directory, "fake-claude");
  const observedPath = path.join(directory, "observed.json");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.306 (Claude Code)"); process.exit(0); }
if (args.includes("status")) { console.log(JSON.stringify({loggedIn:true,authMethod:options.authMethod || "claude.ai",subscriptionType:options.subscription || "max",apiProvider:"firstParty",email:"synthetic@example.invalid"})); process.exit(0); }
const session = args.find(value => value.startsWith("--session-id=") || value.startsWith("--resume=")).split("=")[1];
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = readline.createInterface({input:process.stdin});
const requests = [];
let turn;
const finish = () => {
  out({type:"assistant",session_id:session,message:{id:"assistant-one",content:[{type:"text",text:"Interim explanation"}]}});
  out({type:"result",subtype:"success",session_id:options.mode === "wrong-session" ? "00000000-0000-0000-0000-000000000000" : session,is_error:options.mode === "wait-error",result:"Authoritative final",...(options.mode === "wait-error" ? {errors:["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"]} : {})});
  out({type:"system",subtype:"session_state_changed",session_id:session,state:"idle"});
};
lines.on("line", line => {
 const value = JSON.parse(line);
 requests.push(value);
 fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({args,requests,environment:process.env}));
 if (value.type === "control_request") {
   out({type:"control_response",response:{subtype:"success",request_id:value.request_id,response:{account:{apiProvider:"firstParty",subscriptionType:"Claude Max",...(options.mode === "api-init" ? {apiKeySource:"ANTHROPIC_API_KEY"} : {})},current_permission_mode:options.permissionMode || "default"}}});
   if(value.request.subtype === "interrupt") finish();
 }
 if (value.type === "user") {
  turn=value;
  out({type:"system",subtype:"init",session_id:session,apiKeySource:"none"});
  out({type:"system",subtype:"session_state_changed",session_id:session,state:"running"});
  if(options.mode === "crash") { process.exit(9); }
  if(options.mode === "wait" || options.mode === "wait-error") return;
  if(options.mode === "permission" || options.mode === "unknown-tool" || options.mode === "question") {
   let tool="Bash"; let input={command:"echo synthetic",description:"synthetic command"};
   if(options.mode === "unknown-tool") {tool="UnreviewedTool";input={target:"synthetic"};}
   if(options.mode === "question") {tool="AskUserQuestion";input={questions:[{question:"Which format?",header:"Format",multiSelect:false,options:[{label:"Summary",description:"Brief"},{label:"Detailed",description:"Full"}]}]};}
   out({type:"control_request",request_id:"permission-one",request:{subtype:"can_use_tool",tool_name:tool,input,tool_use_id:"tool-one"}});
   return;
  }
  finish();
 }
 if(value.type === "control_response") finish();
});
lines.on("close", () => { if(options.mode === "bad-exit") process.exit(7); if(options.mode === "wait-error") process.exit(1); process.exit(0); });
`;
  await writeFile(executablePath, script);
  await chmod(executablePath, 0o700);
  const conversation = new ClaudeConversation({
    executablePath,
    stateDirectory: path.join(directory, "state"),
    cwd: directory,
  });
  const events: unknown[] = [];
  conversation.subscribe((event) => events.push(event));
  const session = await conversation.startThread(directory);
  return {
    conversation,
    events,
    session,
    directory,
    executablePath,
    async observed(): Promise<unknown> {
      return JSON.parse(await readFile(observedPath, "utf8"));
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function terminal(harness: Awaited<ReturnType<typeof fixture>>, turn: string) {
  await vi.waitFor(async () =>
    expect((await harness.conversation.readTurn(harness.session, turn))?.status).not.toBe(
      "inProgress",
    ),
  );
  return harness.conversation.readTurn(harness.session, turn);
}

describe("Claude local subscription adapter", () => {
  it("inspects native login without returning account details or allowing API billing", async () => {
    const harness = await fixture();
    expect(await inspectClaudeReadiness({ executablePath: harness.executablePath })).toEqual({
      provider: "claude",
      version: "2.1.306 (Claude Code)",
      authMethod: "claude.ai",
      subscription: "max",
    });
    const api = await fixture({ authMethod: "api_key" });
    await expect(api.conversation.start()).rejects.toThrow("API billing is disabled");
    await Promise.all([harness.conversation.close(), api.conversation.close()]);
  });
  it("terminalizes a reserved turn when shutdown wins while its ledger is saving", async () => {
    const harness = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let notifySaving = (): void => {};
    let releaseSave = (): void => {};
    const saving = new Promise<void>((resolve) => {
      notifySaving = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      notifySaving();
      await released;
      await original.rename(source, destination);
    });
    const starting = harness.conversation.startTurn(harness.session, "Do not send after shutdown");
    const rejected = expect(starting).rejects.toBeInstanceOf(ConversationDispatchRejectedError);
    await saving;
    await harness.conversation.close();
    releaseSave();
    await rejected;
    await expect(harness.observed()).rejects.toThrow();
    const resumed = new ClaudeConversation({
      executablePath: harness.executablePath,
      stateDirectory: path.join(harness.directory, "state"),
      cwd: harness.directory,
    });
    const history = await resumed.readThread(harness.session);
    expect(history).toMatchObject({
      thread: { id: harness.session, turns: [{ status: "failed" }] },
    });
    await expect(resumed.resumeThread(harness.session, harness.directory)).resolves.toBeUndefined();
    await resumed.close();
  });
  it("rejects workspace authentication overrides before spawning inference", async () => {
    const harness = await fixture();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(harness.directory, ".claude"));
    await writeFile(
      path.join(harness.directory, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "synthetic-key" } }),
    );
    await expect(
      harness.conversation.startTurn(harness.session, "Do not send"),
    ).rejects.toBeInstanceOf(ConversationDispatchRejectedError);
    await expect(harness.observed()).rejects.toThrow();
    await harness.conversation.close();
  });
  it("checks startup authentication settings in the configured workspace", async () => {
    const harness = await fixture();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(harness.directory, ".claude"));
    await writeFile(
      path.join(harness.directory, ".claude", "settings.json"),
      JSON.stringify({ apiKeyHelper: "synthetic-helper" }),
    );
    await expect(harness.conversation.readiness()).rejects.toThrow("API key helpers are disabled");
    await harness.conversation.close();
  });
  it("rejects initialized API authentication without sending user input", async () => {
    const harness = await fixture({ mode: "api-init" });
    await expect(
      harness.conversation.startTurn(harness.session, "Do not send"),
    ).rejects.toBeInstanceOf(ConversationDispatchRejectedError);
    const observed = await harness.observed();
    if (!record(observed) || !Array.isArray(observed.requests))
      throw new Error("Missing synthetic observations");
    expect(observed.requests.some((request) => record(request) && request.type === "user")).toBe(
      false,
    );
    await harness.conversation.close();
  });
  it("removes API credentials, provider overrides, and nested-agent state from child environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "synthetic-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-oauth");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://synthetic.invalid");
    vi.stubEnv("CLAUDECODE", "1");
    const environment = claudeChildEnvironment();
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "ANTHROPIC_BASE_URL",
      "CLAUDECODE",
    ])
      expect(environment[key]).toBeUndefined();
    expect(environment.HOME).toBe(process.env.HOME);
  });
  it("initializes before sending exact stdin input, persists final evidence, and resumes the same native session", async () => {
    const harness = await fixture();
    const turn = await harness.conversation.startTurn(
      harness.session,
      "Synthetic task with @mention",
    );
    const completed = await terminal(harness, turn);
    expect(completed?.status).toBe("completed");
    expect(completed?.items).toContainEqual({
      id: `final-${turn}`,
      type: "agentMessage",
      phase: "final_answer",
      text: "Authoritative final",
    });
    const observed = await harness.observed();
    expect(record(observed)).toBe(true);
    if (!record(observed) || !Array.isArray(observed.requests) || !Array.isArray(observed.args))
      throw new Error("Missing synthetic observations");
    expect(observed.args).not.toContain("Synthetic task with @mention");
    expect(observed.args).not.toContain("--bare");
    expect(observed.args).not.toContain("--permission-mode");
    expect(observed.args).not.toContain("--dangerously-skip-permissions");
    expect(observed.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(observed.requests[0]).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize" },
    });
    expect(observed.requests[1]).toMatchObject({
      type: "user",
      uuid: turn,
      session_id: harness.session,
      message: { content: [{ type: "text", text: "Synthetic task with @mention" }] },
    });
    await harness.conversation.close();
    const resumed = new ClaudeConversation({
      executablePath: harness.executablePath,
      stateDirectory: path.join(harness.directory, "state"),
    });
    expect(await resumed.readTurn(harness.session, turn)).toEqual(completed);
    await resumed.resumeThread(harness.session, harness.directory);
    const next = await resumed.startTurn(harness.session, "Another synthetic task");
    await vi.waitFor(async () =>
      expect((await resumed.readTurn(harness.session, next))?.status).toBe("completed"),
    );
    const again = await harness.observed();
    if (!record(again) || !Array.isArray(again.args))
      throw new Error("Missing synthetic resume observations");
    expect(again.args).toContain(`--resume=${harness.session}`);
    await resumed.close();
  });
  it.each(["auto", "acceptEdits", "plan", "dontAsk", "manual"])(
    "inherits native %s permissions without introducing approval requests",
    async (permissionMode) => {
      const harness = await fixture({ permissionMode });
      const handler = vi.fn(async () => ({ decision: "decline" }));
      harness.conversation.subscribeRequests(handler);
      const turn = await harness.conversation.startTurn(
        harness.session,
        "A synthetic native-mode task",
      );
      expect((await terminal(harness, turn))?.status).toBe("completed");
      expect(handler).not.toHaveBeenCalled();
      const observed = await harness.observed();
      if (!record(observed) || !Array.isArray(observed.args) || !Array.isArray(observed.requests))
        throw new Error("Missing synthetic observations");
      expect(observed.args).not.toContain("--permission-mode");
      expect(observed.args).toContain("--permission-prompt-tool");
      expect(observed.args).toContain("stdio");
      expect(observed.args).toContain('{"forceLoginMethod":"claudeai"}');
      expect(
        observed.requests.some((request) => record(request) && request.type === "control_response"),
      ).toBe(false);
      await harness.conversation.close();
    },
  );
  it.each(["bypassPermissions", "unrecognized"])(
    "rejects unsupported native permission mode %s before sending a prompt",
    async (permissionMode) => {
      const harness = await fixture({ permissionMode });
      await expect(
        harness.conversation.startTurn(harness.session, "Do not send a synthetic prompt"),
      ).rejects.toBeInstanceOf(ConversationDispatchRejectedError);
      const observed = await harness.observed();
      if (!record(observed) || !Array.isArray(observed.requests))
        throw new Error("Missing synthetic observations");
      expect(observed.requests.some((request) => record(request) && request.type === "user")).toBe(
        false,
      );
      await harness.conversation.close();
    },
  );
  it("keeps stdin open for one-time approval and never grants suggested persistent permissions", async () => {
    const harness = await fixture({ mode: "permission" });
    const handler = vi.fn(async () => ({ decision: "accept" }));
    harness.conversation.subscribeRequests(handler);
    const turn = await harness.conversation.startTurn(harness.session, "Run synthetic command");
    await terminal(harness, turn);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "permission-one",
        method: "item/commandExecution/requestApproval",
        params: expect.objectContaining({
          command: "echo synthetic",
          threadId: harness.session,
          turnId: turn,
        }),
      }),
    );
    const observed = await harness.observed();
    if (!record(observed) || !Array.isArray(observed.requests))
      throw new Error("Missing synthetic observations");
    expect(observed.requests).toContainEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "permission-one",
        response: {
          behavior: "allow",
          updatedInput: { command: "echo synthetic", description: "synthetic command" },
        },
      },
    });
    await harness.conversation.close();
  });
  it("denies unknown tools without forwarding or executing them", async () => {
    const harness = await fixture({ mode: "unknown-tool" });
    const handler = vi.fn(async () => ({ decision: "accept" }));
    harness.conversation.subscribeRequests(handler);
    await terminal(
      harness,
      await harness.conversation.startTurn(harness.session, "Synthetic unknown action"),
    );
    expect(handler).not.toHaveBeenCalled();
    const observed = await harness.observed();
    if (!record(observed) || !Array.isArray(observed.requests))
      throw new Error("Missing synthetic observations");
    expect(observed.requests).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          response: expect.objectContaining({ behavior: "deny" }),
        }),
      }),
    );
    await harness.conversation.close();
  });
  it("maps structured questions and free text back to the original question text", async () => {
    const harness = await fixture({ mode: "question" });
    harness.conversation.subscribeRequests(async () => ({
      answers: { "question-1": { answers: ["A synthetic custom response"] } },
    }));
    await terminal(
      harness,
      await harness.conversation.startTurn(harness.session, "Ask a synthetic question"),
    );
    const observed = await harness.observed();
    if (!record(observed) || !Array.isArray(observed.requests))
      throw new Error("Missing synthetic observations");
    expect(observed.requests).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          response: expect.objectContaining({
            behavior: "allow",
            updatedInput: expect.objectContaining({
              answers: { "Which format?": "A synthetic custom response" },
            }),
          }),
        }),
      }),
    );
    await harness.conversation.close();
  });
  it.each(["wrong-session", "bad-exit", "crash"])(
    "keeps %s outcomes uncertain and prevents replay after restart",
    async (mode) => {
      const harness = await fixture({ mode });
      const turn = await harness.conversation.startTurn(
        harness.session,
        "Synthetic uncertain task",
      );
      await vi.waitFor(() =>
        expect(harness.events).toContainEqual(
          expect.objectContaining({ method: "turn/uncertain" }),
        ),
      );
      await harness.conversation.close();
      const resumed = new ClaudeConversation({
        executablePath: harness.executablePath,
        stateDirectory: path.join(harness.directory, "state"),
      });
      expect((await resumed.readTurn(harness.session, turn))?.status).toBe("inProgress");
      await expect(resumed.resumeThread(harness.session, harness.directory)).rejects.toThrow(
        "terminal evidence",
      );
      expect(
        harness.events.filter((event) => record(event) && event.method === "turn/completed"),
      ).toHaveLength(0);
      await resumed.close();
    },
  );
  it.each(["wait", "wait-error"])(
    "queues unsupported steering and confirms interruption from native %s result",
    async (mode) => {
      const harness = await fixture({ mode });
      const turn = await harness.conversation.startTurn(harness.session, "Synthetic waiting task");
      await expect(
        harness.conversation.steer(harness.session, turn, "Synthetic followup"),
      ).rejects.toBeInstanceOf(ConversationSteerUnavailableError);
      await expect(
        harness.conversation.interrupt(harness.session, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("matching active");
      await harness.conversation.interrupt(harness.session, turn);
      const interrupted = await terminal(harness, turn);
      expect(interrupted?.status).toBe("interrupted");
      expect(interrupted?.error).toEqual({ message: "Claude turn was interrupted" });
      expect(JSON.stringify(interrupted)).not.toContain("ede_diagnostic");
      await harness.conversation.close();
    },
  );
});
