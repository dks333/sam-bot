import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppServerResponseError,
  ProcessAppServerConnection,
} from "../src/codex/app-server-client.js";
import type { NativeStartupEvent } from "../src/codex/startup-observation.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn() };
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processFixture(interruptInitialize = false) {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Record<string, unknown>[] = [];
  Object.defineProperties(child, {
    exitCode: { value: 0 },
    stderr: { value: stderr },
    stdin: { value: stdin },
    stdout: { value: stdout },
  });
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    for (const line of chunk.trim().split("\n")) {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message)) {
        throw new Error("Invalid test protocol message");
      }
      sent.push(message);
      if (message.method === "initialize") {
        if (interruptInitialize) {
          stdout.write(
            `${JSON.stringify({ id: message.id, method: "item/tool/requestUserInput", params: {} })}\n`,
          );
        }
        stdout.write(
          `${JSON.stringify({
            id: message.id,
            result: {
              codexHome: "/synthetic/codex-home",
              platformFamily: "synthetic-platform",
              platformOs: "synthetic-os",
              userAgent: "codex_cli_rs/0.155.1 (synthetic-platform)",
            },
          })}\n`,
        );
      }
    }
  });
  vi.mocked(spawn).mockReturnValue(child);
  return { child, sent, stdout };
}

describe("App Server request contracts", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("preserves structured native refusal evidence without converting transport failures into admission proof", async () => {
    const fixture = processFixture();
    const connection = await ProcessAppServerConnection.create();
    const pending = connection.request("turn/steer", {
      threadId: "synthetic-thread",
      expectedTurnId: "synthetic-turn",
    });
    const sent = fixture.sent.at(-1);
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AppServerResponseError",
      code: -32600,
      data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } },
    });
    fixture.stdout.write(
      `${JSON.stringify({ id: sent?.id, error: { code: -32600, message: "cannot steer a review turn", data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } } } })}\n`,
    );
    await rejected;
    expect(new AppServerResponseError("synthetic")).toBeInstanceOf(Error);
    await connection.close();
  });

  it("launches the packaged executable with native settings and local authentication", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-excluded-api-key");
    const fixture = processFixture();
    const connection = await ProcessAppServerConnection.create();
    expect(fixture.sent).toContainEqual(
      expect.objectContaining({
        method: "initialize",
        params: expect.objectContaining({
          clientInfo: { name: "sam-bot", title: "Sam Bot", version: "0.1.0" },
        }),
      }),
    );
    const call = vi.mocked(spawn).mock.calls[0];
    if (call === undefined || !Array.isArray(call[1]))
      throw new Error("Expected native child process arguments");
    expect(call[1][0]).toEqual(expect.stringContaining("@openai/codex"));
    expect(call[1].slice(1)).toEqual(["app-server"]);
    expect(call[2]?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(call[2]?.env?.HOME).toBe(process.env.HOME);
    await connection.close();
  });

  it("launches an explicitly selected native executable without bridge configuration flags", async () => {
    processFixture();
    const connection = await ProcessAppServerConnection.create({
      executablePath: "/synthetic/desktop/codex",
      codexHome: "/synthetic/global-codex-home",
    });
    const call = vi.mocked(spawn).mock.calls[0];
    expect(call?.[0]).toBe("/synthetic/desktop/codex");
    expect(call?.[1]).toEqual(["app-server"]);
    expect(call?.[2]?.env).toMatchObject({
      CODEX_HOME: "/synthetic/global-codex-home",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "slack_codex_local",
    });
    expect(JSON.stringify(call?.[1])).not.toMatch(/features|model|sandbox|approval|memory/u);
    await connection.close();
  });

  it.each(["relative/codex", "/synthetic/codex\ninvalid"])(
    "does not launch an invalid explicitly selected native executable",
    async (executablePath) => {
      await expect(ProcessAppServerConnection.create({ executablePath })).rejects.toThrow(
        "absolute path",
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    "item/permissions/requestApproval",
    "mcpServer/elicitation/request",
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
    "currentTime/read",
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "synthetic/futureRequest",
  ])("forwards every native %s request to the registered interaction handler", async (method) => {
    const fixture = processFixture();
    const connection = await ProcessAppServerConnection.create();
    const result = { nativeResponse: "preserved" };
    const handler = vi.fn(async () => result);
    connection.subscribeRequests(handler);
    const params = { threadId: "native-thread", turnId: "native-turn" };
    fixture.stdout.write(`${JSON.stringify({ id: "native-request", method, params })}\n`);
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledExactlyOnceWith({ id: "native-request", method, params }),
    );
    await vi.waitFor(() => expect(fixture.sent).toContainEqual({ id: "native-request", result }));
    await connection.close();
  });

  it("rejects native requests without an interaction handler using their original identities", async () => {
    const fixture = processFixture();
    const connection = await ProcessAppServerConnection.create();
    fixture.stdout.write(
      `${JSON.stringify({ id: "permissions", method: "item/permissions/requestApproval", params: {} })}\n`,
    );
    fixture.stdout.write(
      `${JSON.stringify({ id: 91, method: "synthetic/futureRequest", params: {} })}\n`,
    );
    await vi.waitFor(() => {
      for (const id of ["permissions", 91])
        expect(fixture.sent).toContainEqual({
          id,
          error: { code: -32_601, message: "A native interaction handler is not registered" },
        });
    });
    await connection.close();
  });

  it("reports bounded startup stages without native parameters or response contents", async () => {
    processFixture();
    const events: NativeStartupEvent[] = [];
    const connection = await ProcessAppServerConnection.create({
      codexHome: "/synthetic/private-native-home",
      onStartup: (event) => events.push(event),
    });
    expect(events.map((event) => `${event.stage}:${event.state}`)).toEqual([
      "process-launch:starting",
      "process-launch:completed",
      "initialize-rpc:starting",
      "initialize-rpc:completed",
    ]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["elapsedMs", "stage", "state"]);
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(event.elapsedMs).toBeLessThanOrEqual(90_000);
    }
    expect(JSON.stringify(events)).not.toContain("private-native-home");
    expect(JSON.stringify(events)).not.toContain("userAgent");
    await connection.close();
  });

  it("keeps native initialization working if a diagnostic observer throws", async () => {
    processFixture();
    const connection = await ProcessAppServerConnection.create({
      onStartup: () => {
        throw new Error("Synthetic diagnostic sink failure");
      },
    });
    expect(connection.runtimeInfo().initializationObserved).toBe(true);
    await connection.close();
  });

  it("reports a failed launch without disclosing the launch error in telemetry", async () => {
    const events: NativeStartupEvent[] = [];
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("Synthetic private native launch failure");
    });
    await expect(
      ProcessAppServerConnection.create({ onStartup: (event) => events.push(event) }),
    ).rejects.toThrow("Synthetic private native launch failure");
    expect(events.map((event) => `${event.stage}:${event.state}`)).toEqual([
      "process-launch:starting",
      "process-launch:failed",
    ]);
    expect(JSON.stringify(events)).not.toContain("private native launch failure");
  });

  it("terminates an uninitialized native child when startup is cancelled", async () => {
    const child = new ChildProcess();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.defineProperties(child, {
      exitCode: { value: null },
      signalCode: { value: null, configurable: true },
      stderr: { value: stderr },
      stdin: { value: stdin },
      stdout: { value: stdout },
    });
    const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
      Object.defineProperty(child, "signalCode", { value: signal });
      child.emit("exit", null, signal);
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child);
    const controller = new AbortController();
    const events: NativeStartupEvent[] = [];
    const starting = ProcessAppServerConnection.create({
      signal: controller.signal,
      onStartup: (event) => events.push(event),
    });
    const rejected = expect(starting).rejects.toThrow("connection closed");
    controller.abort(new Error("Synthetic startup cancellation"));
    await rejected;
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(child.signalCode).toBe("SIGTERM");
    expect(events.map((event) => `${event.stage}:${event.state}`)).toEqual([
      "process-launch:starting",
      "process-launch:completed",
      "initialize-rpc:starting",
      "initialize-rpc:failed",
    ]);
  });

  it("does not launch a native child for an already cancelled startup", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Synthetic startup cancellation"));
    await expect(ProcessAppServerConnection.create({ signal: controller.signal })).rejects.toThrow(
      "startup cancellation",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("waits for observed forced termination when initialization ignores SIGTERM", async () => {
    vi.useFakeTimers();
    const child = new ChildProcess();
    Object.defineProperties(child, {
      exitCode: { value: null },
      signalCode: { value: null, configurable: true },
      stderr: { value: new PassThrough() },
      stdin: { value: new PassThrough() },
      stdout: { value: new PassThrough() },
    });
    const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
      if (signal === "SIGKILL") {
        Object.defineProperty(child, "signalCode", { value: signal });
        child.emit("exit", null, signal);
      }
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child);
    const controller = new AbortController();
    const starting = ProcessAppServerConnection.create({ signal: controller.signal });
    const rejected = expect(starting).rejects.toThrow("connection closed");
    controller.abort(new Error("Synthetic startup cancellation"));
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("does not confuse server requests with outgoing responses sharing a numeric ID", async () => {
    const fixture = processFixture(true);
    const connection = await ProcessAppServerConnection.create();
    expect(fixture.sent).toContainEqual({
      error: { code: -32_601, message: "A native interaction handler is not registered" },
      id: 1,
    });
    await connection.close();
  });

  it("keeps user input pending until the registered handler resolves", async () => {
    const fixture = processFixture();
    const connection = await ProcessAppServerConnection.create();
    let answer: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      answer = resolve;
    });
    const handler = vi.fn(async () => pending);
    connection.subscribeRequests(handler);
    fixture.stdout.write(
      `${JSON.stringify({ id: "question-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1" } })}\n`,
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(fixture.sent.some((message) => message.id === "question-1")).toBe(false);
    answer({ answers: { selected: { answers: ["Synthetic option"] } } });
    await vi.waitFor(() =>
      expect(fixture.sent).toContainEqual({
        id: "question-1",
        result: { answers: { selected: { answers: ["Synthetic option"] } } },
      }),
    );
    await connection.close();
  });

  it("returns a closed failure when an interaction handler rejects", async () => {
    const fixture = processFixture();
    const connection = await ProcessAppServerConnection.create();
    connection.subscribeRequests(async () => {
      throw new Error("sensitive internal detail");
    });
    fixture.stdout.write(
      `${JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} })}\n`,
    );
    await vi.waitFor(() =>
      expect(fixture.sent).toContainEqual({
        id: "approval-1",
        error: { code: -32_603, message: "Codex user interaction could not be completed" },
      }),
    );
    expect(JSON.stringify(fixture.sent)).not.toContain("sensitive internal detail");
    await connection.close();
  });

  it("retains observed native build metadata without exposing the configured home", async () => {
    processFixture();
    const connection = await ProcessAppServerConnection.create();
    expect(connection.runtimeInfo()).toEqual({
      initializationObserved: true,
      platformFamily: "synthetic-platform",
      platformOs: "synthetic-os",
      userAgent: "codex_cli_rs/0.155.1 (synthetic-platform)",
    });
    expect(JSON.stringify(connection.runtimeInfo())).not.toContain("codex-home");
    await connection.close();
  });
});
