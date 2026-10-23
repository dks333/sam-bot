import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerRequest } from "../src/codex/app-server-client.js";
import { NativeInputRelay } from "../src/slack/native-input-relay.js";
import { WebApiSlackResponder } from "../src/slack/responder.js";

const relays: NativeInputRelay[] = [];
const binding = {
  eventId: "synthetic-event",
  threadId: "synthetic-thread",
  turnId: "synthetic-turn",
  teamId: "synthetic-team",
  userId: "synthetic-owner",
  channelId: "synthetic-channel",
  threadTs: "1.0",
};

function fixture(agentName = "Codex", redact?: (text: string) => string) {
  const client = new WebClient("synthetic-token");
  const postEphemeral = vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({ ok: true });
  const postInfo = vi.fn(async (_input: { text: string }) => {});
  const responder = new WebApiSlackResponder(client, 3_500, redact);
  const relay = new NativeInputRelay({
    agentName,
    ...(redact === undefined ? {} : { redactSensitiveText: redact }),
    postInfo,
    postApproval: async (input) => {
      await responder.postApproval({ channelId: input.channelId, threadTs: input.threadTs }, input);
    },
  });
  relays.push(relay);
  return { relay, responder, postEphemeral, postInfo };
}

function request(command: string, id = 1): AppServerRequest {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: binding.threadId,
      turnId: binding.turnId,
      command,
      cwd: "/tmp/synthetic-workspace",
      availableDecisions: ["accept", "decline"],
    },
  };
}

function approvalBlocks(harness: ReturnType<typeof fixture>, index = -1) {
  const payload = harness.postEphemeral.mock.calls.at(index)?.[0];
  if (payload === undefined || !("blocks" in payload) || !Array.isArray(payload.blocks)) {
    throw new Error("Expected approval blocks");
  }
  return payload.blocks;
}

function approvalId(harness: ReturnType<typeof fixture>): string {
  for (const block of approvalBlocks(harness)) {
    if (block.type !== "actions" || !("elements" in block) || !Array.isArray(block.elements)) {
      continue;
    }
    for (const element of block.elements) {
      if (element.type === "button" && element.action_id === "bridge_approve_once") {
        if (typeof element.value === "string") return element.value;
      }
    }
  }
  throw new Error("Expected one-time approval identifier");
}

afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
  vi.restoreAllMocks();
});

describe("native approval integrity at the Slack boundary", () => {
  it.each(["Codex", "Claude Code"])(
    "preserves distinct absolute execution scopes for %s",
    async (agentName) => {
      const harness = fixture(agentName);
      const firstCommand = "rm -rf /tmp/synthetic-first";
      const secondCommand = "rm -rf /tmp/synthetic-second";
      const first = harness.relay.request(request(firstCommand), binding);
      const firstId = approvalId(harness);
      expect(harness.postEphemeral.mock.calls[0]?.[0]).toMatchObject({
        channel: binding.channelId,
        user: binding.userId,
        thread_ts: binding.threadTs,
        parse: "none",
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              emoji: false,
              text: expect.stringContaining(firstCommand),
            },
          },
          { type: "actions" },
        ],
      });
      const second = harness.relay.request(request(secondCommand, 2), binding);
      const secondId = approvalId(harness);
      expect(approvalBlocks(harness, 1)).toMatchObject([
        { text: { text: expect.stringContaining(secondCommand) } },
        { type: "actions" },
      ]);
      expect(firstId).not.toBe(secondId);
      expect(
        harness.relay.approve({
          ...binding,
          userId: "synthetic-other",
          approvalId: firstId,
          approved: true,
        }),
      ).toBe(false);
      expect(harness.relay.approve({ ...binding, approvalId: firstId, approved: true })).toBe(true);
      expect(await first).toEqual({ decision: "accept" });
      expect(harness.relay.approve({ ...binding, approvalId: firstId, approved: true })).toBe(
        false,
      );
      harness.relay.invalidateThread(binding.threadId);
      expect(await second).toEqual({ decision: "cancel" });
    },
  );

  it.each(["Codex", "Claude Code"])(
    "never authorizes %s shell execution hidden inside a redacted value",
    async (agentName) => {
      const harness = fixture(agentName);
      await expect(
        harness.relay.request(request("synthetic-command --token=$(synthetic-hidden)"), binding),
      ).rejects.toThrow("sensitive values");
      expect(harness.postEphemeral).not.toHaveBeenCalled();
      expect(harness.relay.pendingCount(binding)).toBe(0);
      expect(JSON.stringify(harness.postInfo.mock.calls)).not.toContain("synthetic-hidden");
    },
  );

  it("rejects the original scope size before a redactor could shorten it", async () => {
    const secret = "s".repeat(3_000);
    const harness = fixture("Codex", (text) => text.replaceAll(secret, "[REDACTED]"));
    await expect(harness.relay.request(request(`printf '${secret}'`), binding)).rejects.toThrow(
      "full scope",
    );
    expect(harness.postEphemeral).not.toHaveBeenCalled();
    expect(harness.relay.pendingCount(binding)).toBe(0);
  });

  it.each(["\r", "\u001b", "\u202e", "\u200b", "\u2066"])(
    "does not authorize an action with a hidden display character %j",
    async (character) => {
      const harness = fixture();
      await expect(
        harness.relay.request(request(`printf safe${character}synthetic-hidden`), binding),
      ).rejects.toThrow("hidden display characters");
      expect(harness.postEphemeral).not.toHaveBeenCalled();
      expect(harness.relay.pendingCount(binding)).toBe(0);
    },
  );

  it("transmits Slack syntax literally in the private scope instead of interpreting it", async () => {
    const harness = fixture();
    const command = "printf '<https://synthetic.invalid|safe> <!channel> :smile: `hidden`'";
    const pending = harness.relay.request(request(command), binding);
    expect(approvalBlocks(harness, 0)).toMatchObject([
      {
        text: { type: "plain_text", emoji: false, text: expect.stringContaining(command) },
      },
      { type: "actions" },
    ]);
    harness.relay.close();
    expect(await pending).toEqual({ decision: "cancel" });
  });

  it("displays a write grant alongside changed paths instead of hiding its broader scope", async () => {
    const harness = fixture();
    const pending = harness.relay.request(
      {
        ...request("synthetic"),
        method: "item/fileChange/requestApproval",
        params: {
          threadId: binding.threadId,
          turnId: binding.turnId,
          changes: [{ path: "/tmp/synthetic-workspace/file.txt" }],
          grantRoot: "/tmp/synthetic-parent",
        },
      },
      binding,
    );
    expect(approvalBlocks(harness, 0)).toMatchObject([
      { text: { text: expect.stringContaining('Write scope: "/tmp/synthetic-parent"') } },
      { type: "actions" },
    ]);
    harness.relay.close();
    expect(await pending).toEqual({ decision: "cancel" });
  });

  it.each(["synthetic-command --token=synthetic-secret", "x".repeat(2_701), "safe\u202ehidden"])(
    "makes the responder refuse unsafe scopes even without the relay: %j",
    async (summary) => {
      const harness = fixture();
      await expect(
        harness.responder.postApproval(binding, {
          approvalId: "synthetic-id",
          expiresAt: "2026-01-01T00:00:00.000Z",
          summary,
          userId: binding.userId,
        }),
      ).rejects.toThrow("full scope cannot be shown safely");
      expect(harness.postEphemeral).not.toHaveBeenCalled();
    },
  );

  it("uses the injected secret policy for both relay and direct responder approvals", async () => {
    const secret = "synthetic-configured-credential";
    const redact = (text: string) => text.replaceAll(secret, "[REDACTED]");
    const harness = fixture("Codex", redact);
    await expect(harness.relay.request(request(`printf '${secret}'`), binding)).rejects.toThrow(
      "sensitive values",
    );
    await expect(
      harness.responder.postApproval(binding, {
        approvalId: "synthetic-id",
        expiresAt: "2026-01-01T00:00:00.000Z",
        summary: `printf '${secret}'`,
        userId: binding.userId,
      }),
    ).rejects.toThrow("full scope cannot be shown safely");
    expect(harness.postEphemeral).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.postInfo.mock.calls)).not.toContain(secret);
  });
});
