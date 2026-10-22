import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppServerRequest } from "../src/codex/app-server-client.js";
import { NativeInputRelay } from "../src/slack/native-input-relay.js";

const relays: NativeInputRelay[] = [];
const binding = {
  eventId: "synthetic-event",
  threadId: "synthetic-native-thread",
  turnId: "synthetic-native-turn",
  teamId: "synthetic-team",
  userId: "synthetic-owner",
  channelId: "synthetic-channel",
  threadTs: "1.0",
};

function fixture() {
  const postApproval = vi.fn(
    async (_input: {
      approvalId: string;
      expiresAt: string;
      summary: string;
      userId: string;
      channelId: string;
      threadTs: string;
    }) => {},
  );
  const postInfo = vi.fn(
    async (_input: { channelId: string; threadTs: string; text: string }) => {},
  );
  const onChange = vi.fn();
  const relay = new NativeInputRelay({ postApproval, postInfo, onChange });
  relays.push(relay);
  return { relay, postApproval, postInfo, onChange };
}

function request(
  method = "item/commandExecution/requestApproval",
  params: Record<string, unknown> = {},
  id: number | string = 1,
): AppServerRequest {
  return {
    id,
    method,
    params: {
      threadId: binding.threadId,
      turnId: binding.turnId,
      itemId: "synthetic-item",
      command: "printf synthetic",
      ...params,
    },
  };
}

function approvalId(harness: ReturnType<typeof fixture>): string {
  const posted = harness.postApproval.mock.calls.at(-1)?.[0];
  if (posted === undefined) throw new Error("Expected a synthetic approval prompt");
  return posted.approvalId;
}

function answerId(harness: ReturnType<typeof fixture>): string {
  const text = harness.postInfo.mock.calls.at(-1)?.[0].text;
  const match = text?.match(/answer ([a-f\d-]{36}) /u);
  if (match?.[1] === undefined) throw new Error("Expected a synthetic answer prompt");
  return match[1];
}

afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
  vi.useRealTimers();
});

describe("native Slack input relay", () => {
  it("accepts natural free-text answers and publishes owner-bound input lifecycle changes", async () => {
    const harness = fixture();
    const pending = harness.relay.request(
      request("item/tool/requestUserInput", {
        questions: [{ id: "target", question: "Which target?", options: null }],
      }),
      binding,
    );
    expect(harness.relay.pendingCount(binding)).toBe(1);
    expect(harness.postInfo).toHaveBeenCalledWith(
      expect.objectContaining({ userId: binding.userId }),
    );
    expect(
      harness.relay.answerPending({ ...binding, userId: "other-owner", text: "synthetic target" }),
    ).toBe("not-answer");
    expect(harness.relay.answerPending({ ...binding, text: "token=synthetic-private-value" })).toBe(
      "invalid",
    );
    expect(harness.relay.answerPending({ ...binding, text: "synthetic target" })).toBe("accepted");
    expect(await pending).toEqual({ answers: { target: { answers: ["synthetic target"] } } });
    expect(harness.relay.pendingCount(binding)).toBe(0);
    expect(harness.onChange).toHaveBeenCalledTimes(2);
  });

  it("accepts a natural valid choice and leaves nonanswers available for steering", async () => {
    const harness = fixture();
    const pending = harness.relay.request(
      request("item/tool/requestUserInput", {
        questions: [
          {
            id: "choice",
            question: "Choose?",
            options: [{ label: "Synthetic option", description: "A choice" }],
            isOther: false,
          },
        ],
      }),
      binding,
    );
    expect(harness.relay.answerPending({ ...binding, text: "Investigate another target" })).toBe(
      "not-answer",
    );
    expect(harness.relay.pendingCount(binding)).toBe(1);
    expect(harness.relay.answerPending({ ...binding, text: "synthetic option" })).toBe("accepted");
    expect(await pending).toEqual({ answers: { choice: { answers: ["Synthetic option"] } } });
  });

  it("never turns an ordinary yes or answer invalidation into an approval decision", async () => {
    const harness = fixture();
    const pending = harness.relay.request(request(), binding);
    expect(harness.relay.answerPending({ ...binding, text: "yes" })).toBe("not-answer");
    harness.relay.invalidateAnswers(binding.threadId);
    expect(harness.relay.pendingCount(binding)).toBe(1);
    expect(
      harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: false }),
    ).toBe(true);
    expect(await pending).toEqual({ decision: "decline" });
  });

  it("answers native clock requests truthfully without an approval prompt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.999Z"));
    const harness = fixture();
    const result = await harness.relay.request(
      { id: 1, method: "currentTime/read", params: { threadId: binding.threadId } },
      binding,
    );
    expect(result).toEqual({ currentTimeAt: 1_767_225_600 });
    expect(harness.postApproval).not.toHaveBeenCalled();
    expect(harness.postInfo).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "relays one-time command decisions without persistent grants: %s",
    async (approved) => {
      const harness = fixture();
      const result = harness.relay.request(request(), binding);
      const id = approvalId(harness);
      expect(harness.relay.approve({ ...binding, approvalId: id, approved })).toBe(true);
      let decision = "decline";
      if (approved) decision = "accept";
      expect(await result).toEqual({ decision });
      expect(harness.relay.approve({ ...binding, approvalId: id, approved: true })).toBe(false);
    },
  );

  it.each(["teamId", "userId", "channelId", "threadTs"])(
    "rejects approval from a different %s without consuming it",
    async (field) => {
      const harness = fixture();
      const result = harness.relay.request(request(), binding);
      const id = approvalId(harness);
      expect(
        harness.relay.approve({
          ...binding,
          [field]: "synthetic-other",
          approvalId: id,
          approved: true,
        }),
      ).toBe(false);
      expect(harness.relay.approve({ ...binding, approvalId: id, approved: true })).toBe(true);
      expect(await result).toEqual({ decision: "accept" });
    },
  );

  it("shows managed network scope without requiring a shell command", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request(undefined, {
        command: null,
        networkApprovalContext: { host: "synthetic.invalid", protocol: "https" },
        additionalPermissions: { network: { enabled: true }, fileSystem: null },
      }),
      binding,
    );
    expect(harness.postApproval.mock.calls[0]?.[0].summary).toContain("synthetic.invalid");
    expect(harness.postApproval.mock.calls[0]?.[0].summary).toContain("Requested permissions");
    harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: true });
    expect(await result).toEqual({ decision: "accept" });
  });

  it("distinguishes terminal input approvals in the preview", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request(undefined, { kind: "writeStdin", approvalId: "synthetic-callback" }),
      binding,
    );
    expect(harness.postApproval.mock.calls[0]?.[0].summary).toContain("existing terminal");
    harness.relay.invalidateThread(binding.threadId);
    expect(await result).toEqual({ decision: "cancel" });
  });

  it("does not turn a policy amendment into a one-time grant", async () => {
    const harness = fixture();
    await expect(
      harness.relay.request(
        request(undefined, {
          availableDecisions: [
            "decline",
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["synthetic"] } },
          ],
        }),
        binding,
      ),
    ).rejects.toThrow("one-time approval");
    expect(harness.postApproval).not.toHaveBeenCalled();
    expect(harness.postInfo.mock.calls[0]?.[0].text).toContain("locally");
  });

  it("requires reviewable file scope and relays supplied changed paths", async () => {
    const harness = fixture();
    await expect(
      harness.relay.request(request("item/fileChange/requestApproval"), binding),
    ).rejects.toThrow("changed paths");
    const result = harness.relay.request(
      request("item/fileChange/requestApproval", { paths: ["src/synthetic.ts"] }, 2),
      binding,
    );
    expect(harness.postApproval.mock.calls[0]?.[0].summary).toContain("src/synthetic.ts");
    harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: true });
    expect(await result).toEqual({ decision: "accept" });
  });

  it("grants only the exact requested permission snapshot for the current turn", async () => {
    const harness = fixture();
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: null, write: ["/tmp/synthetic-workspace"] },
    };
    const result = harness.relay.request(
      request("item/permissions/requestApproval", { permissions }),
      binding,
    );
    permissions.fileSystem.write.push("/tmp/synthetic-unapproved");
    harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: true });
    expect(await result).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: { read: null, write: ["/tmp/synthetic-workspace"] },
      },
      scope: "turn",
    });
  });

  it("declines permission requests with an empty turn-scoped grant", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request("item/permissions/requestApproval", {
        permissions: { network: { enabled: true }, fileSystem: null },
      }),
      binding,
    );
    harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: false });
    expect(await result).toEqual({ permissions: {}, scope: "turn" });
  });

  it.each([
    { futurePermission: true },
    { network: { enabled: "yes" } },
    { fileSystem: { write: "all" } },
  ])("does not approve unsupported permission shapes: %j", async (permissions) => {
    const harness = fixture();
    await expect(
      harness.relay.request(request("item/permissions/requestApproval", { permissions }), binding),
    ).rejects.toThrow("unsupported permission");
    expect(harness.postApproval).not.toHaveBeenCalled();
  });

  it("answers a single free-text native question with nullable options", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request("item/tool/requestUserInput", {
        questions: [
          {
            id: "target",
            question: "Which synthetic target?",
            options: null,
            isOther: true,
            isSecret: false,
          },
        ],
        isBlocking: false,
      }),
      binding,
    );
    expect(
      harness.relay.answer({ ...binding, text: `answer ${answerId(harness)} synthetic target` }),
    ).toBe(true);
    expect(await result).toEqual({ answers: { target: { answers: ["synthetic target"] } } });
  });

  it("requires exact question IDs for multiple questions", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request("item/tool/requestUserInput", {
        questions: [
          { id: "first", question: "First?", options: null },
          { id: "second", question: "Second?", options: null },
        ],
      }),
      binding,
    );
    const id = answerId(harness);
    expect(harness.relay.answer({ ...binding, text: `answer ${id} incomplete` })).toBe(false);
    expect(
      harness.relay.answer({ ...binding, text: `answer ${id} {"first":"one","second":["two"]}` }),
    ).toBe(true);
    expect(await result).toEqual({
      answers: { first: { answers: ["one"] }, second: { answers: ["two"] } },
    });
  });

  it("does not accept invented choices when no free-form option is offered", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request("item/tool/requestUserInput", {
        questions: [
          {
            id: "choice",
            question: "Choose?",
            options: [{ label: "Synthetic option", description: "A synthetic choice" }],
            isOther: false,
          },
        ],
      }),
      binding,
    );
    const id = answerId(harness);
    expect(harness.relay.answer({ ...binding, text: `answer ${id} another option` })).toBe(false);
    expect(harness.relay.answer({ ...binding, text: `answer ${id} Synthetic option` })).toBe(true);
    expect(await result).toEqual({ answers: { choice: { answers: ["Synthetic option"] } } });
  });

  it("keeps question answers bound to their owner and Slack thread", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request("item/tool/requestUserInput", {
        questions: [{ id: "target", question: "Target?", options: null }],
      }),
      binding,
    );
    const id = answerId(harness);
    expect(
      harness.relay.answer({
        ...binding,
        userId: "synthetic-other",
        text: `answer ${id} synthetic`,
      }),
    ).toBe(false);
    expect(harness.relay.answer({ ...binding, text: `answer ${id} synthetic` })).toBe(true);
    expect(await result).toEqual({ answers: { target: { answers: ["synthetic"] } } });
  });

  it("keeps secret questions and secret-shaped answers out of the relay", async () => {
    const harness = fixture();
    await expect(
      harness.relay.request(
        request("item/tool/requestUserInput", {
          questions: [{ id: "secret", question: "Synthetic secret?", isSecret: true }],
        }),
        binding,
      ),
    ).rejects.toThrow("secret input locally");
    const result = harness.relay.request(
      request(
        "item/tool/requestUserInput",
        { questions: [{ id: "target", question: "Target?", options: null }] },
        2,
      ),
      binding,
    );
    const id = answerId(harness);
    expect(
      harness.relay.answer({ ...binding, text: `answer ${id} token=synthetic-private-value` }),
    ).toBe(false);
    expect(harness.postInfo.mock.calls.map(([input]) => input.text).join("\n")).not.toContain(
      "synthetic-private-value",
    );
    harness.relay.close();
    expect(await result).toEqual({ answers: {} });
  });

  it.each(["form", "openai/form", "openaiForm"])(
    "relays typed JSON MCP forms with nullable turn identity: %s",
    async (mode) => {
      const harness = fixture();
      const result = harness.relay.request(
        request("mcpServer/elicitation/request", {
          turnId: null,
          serverName: "synthetic-server",
          mode,
          message: "Choose the synthetic target",
          requestedSchema: {
            type: "object",
            properties: { confirmed: { type: "boolean" }, count: { type: "integer", minimum: 1 } },
            required: ["confirmed", "count"],
          },
        }),
        binding,
      );
      const id = answerId(harness);
      expect(
        harness.relay.answer({ ...binding, text: `answer ${id} {"confirmed":"yes","count":1}` }),
      ).toBe(false);
      expect(
        harness.relay.answer({
          ...binding,
          text: `answer ${id} {"confirmed":true,"count":1,"extra":true}`,
        }),
      ).toBe(false);
      expect(
        harness.relay.answer({ ...binding, text: `answer ${id} {"confirmed":true,"count":1}` }),
      ).toBe(true);
      expect(await result).toEqual({
        action: "accept",
        content: { confirmed: true, count: 1 },
        _meta: null,
      });
    },
  );

  it.each(["url", "openai/userVerification"])(
    "surfaces local completion without fabricating %s approval",
    async (mode) => {
      const harness = fixture();
      const result = await harness.relay.request(
        request("mcpServer/elicitation/request", {
          turnId: null,
          serverName: "synthetic-server",
          mode,
          url: "https://synthetic.invalid/?token=synthetic-private-value",
          challenge: "synthetic-challenge",
        }),
        binding,
      );
      expect(result).toEqual({ action: "cancel", content: null, _meta: null });
      expect(harness.postApproval).not.toHaveBeenCalled();
      expect(harness.postInfo.mock.calls[0]?.[0].text).not.toContain("synthetic-private-value");
    },
  );

  it("validates MCP titled multiselect choices without inventing enum values", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request("mcpServer/elicitation/request", {
        turnId: null,
        serverName: "synthetic-server",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              minItems: 1,
              items: {
                anyOf: [
                  { const: "first", title: "First" },
                  { const: "second", title: "Second" },
                ],
              },
            },
          },
          required: ["targets"],
        },
      }),
      binding,
    );
    const id = answerId(harness);
    expect(
      harness.relay.answer({ ...binding, text: `answer ${id} {"targets":["invented"]}` }),
    ).toBe(false);
    expect(
      harness.relay.answer({ ...binding, text: `answer ${id} {"targets":["first","second"]}` }),
    ).toBe(true);
    expect(await result).toEqual({
      action: "accept",
      content: { targets: ["first", "second"] },
      _meta: null,
    });
  });

  it("does not render secret form fields in Slack", async () => {
    const harness = fixture();
    await expect(
      harness.relay.request(
        request("mcpServer/elicitation/request", {
          serverName: "synthetic-server",
          mode: "form",
          requestedSchema: { type: "object", properties: { password: { type: "string" } } },
        }),
        binding,
      ),
    ).rejects.toThrow("secret form locally");
    expect(harness.postInfo.mock.calls[0]?.[0].text).not.toContain('"password"');
  });

  it("deduplicates exact native requests and keeps numeric and string IDs distinct", async () => {
    const harness = fixture();
    const first = harness.relay.request(request(), binding);
    const duplicate = harness.relay.request(request(), binding);
    const second = harness.relay.request(request(undefined, {}, "1"), binding);
    expect(harness.postApproval).toHaveBeenCalledTimes(2);
    harness.relay.resolved(binding.threadId, 1);
    expect(await first).toEqual({ decision: "cancel" });
    expect(await duplicate).toEqual({ decision: "cancel" });
    harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: true });
    expect(await second).toEqual({ decision: "accept" });
  });

  it("invalidates only the matching native thread", async () => {
    const harness = fixture();
    const result = harness.relay.request(request(), binding);
    const id = approvalId(harness);
    harness.relay.invalidateThread("synthetic-other-thread");
    expect(harness.relay.approve({ ...binding, approvalId: id, approved: true })).toBe(true);
    expect(await result).toEqual({ decision: "accept" });
    const cancelled = harness.relay.request(request(undefined, {}, 2), binding);
    const cancelledId = approvalId(harness);
    harness.relay.invalidateThread(binding.threadId);
    expect(await cancelled).toEqual({ decision: "cancel" });
    expect(harness.relay.approve({ ...binding, approvalId: cancelledId, approved: true })).toBe(
      false,
    );
  });

  it("expires pending decisions without granting permission", async () => {
    vi.useFakeTimers();
    const harness = fixture();
    const result = harness.relay.request(request(), binding);
    const id = approvalId(harness);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await result).toEqual({ decision: "cancel" });
    expect(harness.relay.approve({ ...binding, approvalId: id, approved: true })).toBe(false);
  });

  it("closes all pending inputs and cannot accept later requests", async () => {
    const harness = fixture();
    const result = harness.relay.request(request(), binding);
    harness.relay.close();
    expect(await result).toEqual({ decision: "cancel" });
    await expect(harness.relay.request(request(undefined, {}, 2), binding)).rejects.toThrow(
      "closed",
    );
  });

  it.each([{ threadId: "synthetic-other-thread" }, { turnId: "synthetic-other-turn" }])(
    "rejects mismatched native authority before presenting input: %j",
    async (params) => {
      const harness = fixture();
      await expect(harness.relay.request(request(undefined, params), binding)).rejects.toThrow(
        "does not belong",
      );
      expect(harness.postApproval).not.toHaveBeenCalled();
    },
  );

  it("reports unsupported methods rather than silently declining them", async () => {
    const harness = fixture();
    await expect(harness.relay.request(request("synthetic/unsupported"), binding)).rejects.toThrow(
      "unsupported Codex request",
    );
    expect(harness.postInfo.mock.calls[0]?.[0].text).toContain("synthetic/unsupported");
  });

  it("does not approve an incomplete or oversized action preview", async () => {
    const harness = fixture();
    await expect(
      harness.relay.request(request(undefined, { command: "x".repeat(4_000) }), binding),
    ).rejects.toThrow("full scope");
    expect(harness.postApproval).not.toHaveBeenCalled();
  });

  it("redacts secrets in approval previews", async () => {
    const harness = fixture();
    const result = harness.relay.request(
      request(undefined, { command: "synthetic-command --token=synthetic-private-value" }),
      binding,
    );
    expect(harness.postApproval.mock.calls[0]?.[0].summary).not.toContain(
      "synthetic-private-value",
    );
    harness.relay.close();
    expect(await result).toEqual({ decision: "cancel" });
  });

  it("does not retain an actionable approval after delivery fails", async () => {
    const harness = fixture();
    harness.postApproval.mockRejectedValueOnce(new Error("Synthetic delivery failure"));
    await expect(harness.relay.request(request(), binding)).rejects.toThrow(
      "could not be presented",
    );
    expect(
      harness.relay.approve({ ...binding, approvalId: approvalId(harness), approved: true }),
    ).toBe(false);
  });
});
