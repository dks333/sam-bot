import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

import { NativeFinalNotSentError } from "../src/bridge/native-final-delivery.js";
import type {
  NativeDelivery,
  NativeFinalIdentity,
} from "../src/persistence/native-conversation-store.js";
import { nativeSlackTransport } from "../src/slack/native-transport.js";

const delivery: NativeDelivery = {
  eventId: "synthetic-event",
  conversationKey: "synthetic-conversation",
  teamId: "T_SYNTHETIC",
  userId: "U_SYNTHETIC_OWNER",
  channelId: "C_SYNTHETIC",
  threadTs: "100.000001",
  messageTs: "100.000002",
  text: "Inspect the synthetic fixture",
  state: "completed",
  finalText: "Synthetic final result",
  completionStatus: "completed",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:01.000Z",
};
const identity: NativeFinalIdentity = {
  id: "00000000-0000-4000-a000-000000000001",
  part: 0,
  contentHash: "a".repeat(64),
  attemptedAt: "2030-01-01T00:00:01.000Z",
};

function message(
  overrides: Partial<{
    user: string;
    bot_id: string;
    thread_ts: string;
    ts: string;
    client_msg_id: string;
  }> = {},
) {
  return {
    user: "U_SYNTHETIC_BOT",
    bot_id: "B_SYNTHETIC",
    thread_ts: delivery.threadTs,
    ts: "100.000003",
    client_msg_id: identity.id,
    ...overrides,
  };
}

function setup() {
  const client = new WebClient("synthetic-credential");
  const auth = vi.spyOn(client.auth, "test").mockResolvedValue({
    ok: true,
    user_id: "U_SYNTHETIC_BOT",
    bot_id: "B_SYNTHETIC",
    team_id: "T_SYNTHETIC",
  });
  const post = vi
    .spyOn(client.chat, "postMessage")
    .mockResolvedValue({ ok: true, channel: delivery.channelId, ts: "100.000003" });
  const update = vi
    .spyOn(client.chat, "update")
    .mockResolvedValue({ ok: true, channel: delivery.channelId, ts: "100.000003" });
  const privatePost = vi
    .spyOn(client.chat, "postEphemeral")
    .mockResolvedValue({ ok: true, message_ts: "100.000004" });
  const replies = vi
    .spyOn(client.conversations, "replies")
    .mockResolvedValue({ ok: true, messages: [], has_more: false });
  return {
    client,
    auth,
    post,
    update,
    privatePost,
    replies,
    transport: nativeSlackTransport(client),
  };
}

describe("Native Slack transport", () => {
  it("replaces the original request reaction through the shared responder", async () => {
    const harness = setup();
    const add = vi.spyOn(harness.client.reactions, "add").mockResolvedValue({ ok: true });
    const remove = vi.spyOn(harness.client.reactions, "remove").mockResolvedValue({ ok: true });
    await harness.transport.setMessageStatus(
      { channelId: delivery.channelId, messageTs: delivery.messageTs },
      "completed",
      "working",
    );
    expect(add).toHaveBeenCalledWith({
      channel: delivery.channelId,
      timestamp: delivery.messageTs,
      name: "white_check_mark",
    });
    expect(remove).toHaveBeenCalledWith({
      channel: delivery.channelId,
      timestamp: delivery.messageTs,
      name: "eyes",
    });
  });

  it("sends the persisted opaque final identity and returns the actual Slack receipt", async () => {
    const harness = setup();
    expect(await harness.transport.postFinal(delivery, "**Synthetic final**", identity)).toBe(
      "100.000003",
    );
    expect(harness.post).toHaveBeenCalledWith({
      channel: delivery.channelId,
      thread_ts: delivery.threadTs,
      client_msg_id: identity.id,
      text: "*Synthetic final*",
      blocks: [],
    });
    expect(harness.auth).not.toHaveBeenCalled();
  });

  it("keeps commentary identity distinct from final identity without startup or Stop controls", async () => {
    const harness = setup();
    await harness.transport.post(delivery, "A useful synthetic finding", -2, true);
    await harness.transport.post(delivery, "The same finding updated", -2);
    await harness.transport.postFinal(delivery, "The synthetic final", identity);
    const first = harness.post.mock.calls[0]?.[0];
    const second = harness.post.mock.calls[1]?.[0];
    const final = harness.post.mock.calls[2]?.[0];
    if (
      first === undefined ||
      second === undefined ||
      final === undefined ||
      !("client_msg_id" in first) ||
      !("client_msg_id" in second) ||
      !("client_msg_id" in final)
    )
      throw new Error("Expected explicit synthetic message identities");
    expect(first.client_msg_id).toBe(second.client_msg_id);
    expect(first.client_msg_id).not.toBe(final.client_msg_id);
    expect(first).toMatchObject({ blocks: [] });
  });

  it.each([
    { ok: false, error: "synthetic_failure" },
    { ok: true },
    { ok: true, ts: "" },
    { ok: true, ts: "unconfirmed" },
    { ok: true, ts: "100.000003", channel: "C_OTHER" },
  ])("does not invent a receipt for invalid post acknowledgement %j", async (response) => {
    const harness = setup();
    harness.post.mockResolvedValueOnce(response);
    await expect(
      harness.transport.postFinal(delivery, "Synthetic final", identity),
    ).rejects.toBeDefined();
  });

  it("updates the exact known receipt and clears old message blocks", async () => {
    const harness = setup();
    await harness.transport.update(delivery, "100.000003", "Synthetic final", true);
    expect(harness.update).toHaveBeenCalledWith({
      channel: delivery.channelId,
      ts: "100.000003",
      text: "Synthetic final",
      blocks: [],
    });
    expect(harness.post).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: "synthetic_failure" },
    { ok: true, ts: "100.000009" },
    { ok: true, ts: "100.000003", channel: "C_OTHER" },
  ])("rejects a mismatched known-message acknowledgement %j", async (response) => {
    const harness = setup();
    harness.update.mockResolvedValueOnce(response);
    await expect(
      harness.transport.update(delivery, "100.000003", "Synthetic final"),
    ).rejects.toThrow("did not confirm");
  });

  it("classifies only an explicit rate-limit rejection as a proven non-send", async () => {
    const harness = setup();
    harness.post.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 17 });
    await expect(
      harness.transport.postFinal(delivery, "Synthetic final", identity),
    ).rejects.toMatchObject({ name: "NativeFinalNotSentError", retryAfterMs: 17_000 });
    harness.update.mockRejectedValueOnce({
      code: "slack_webapi_rate_limited_error",
      retryAfter: 9,
    });
    await expect(
      harness.transport.update(delivery, "100.000003", "Synthetic final"),
    ).rejects.toBeInstanceOf(NativeFinalNotSentError);
  });

  it.each(["invalid_auth", "channel_not_found", "missing_scope"])(
    "retains documented access rejection %s as a delayed proven non-send",
    async (code) => {
      const harness = setup();
      const error = Object.assign(new Error("Synthetic Slack access rejection"), {
        code: "slack_webapi_platform_error",
        data: { error: code, ok: false },
      });
      harness.post.mockRejectedValueOnce(error);
      await expect(
        harness.transport.postFinal(delivery, "Synthetic final", identity),
      ).rejects.toMatchObject({
        name: "NativeFinalNotSentError",
        retryAfterMs: 30_000,
      });
      harness.post.mockResolvedValueOnce({ ok: false, error: code });
      await expect(
        harness.transport.postFinal(delivery, "Synthetic final", identity),
      ).rejects.toBeInstanceOf(NativeFinalNotSentError);
    },
  );

  it.each([
    new Error("Synthetic socket response lost"),
    { code: "slack_webapi_platform_error", data: { error: "internal_error" } },
    { code: "slack_webapi_platform_error", data: { error: "fatal_error" } },
    { code: "slack_webapi_rate_limited_error", retryAfter: Number.NaN },
  ])("preserves uncertain write errors rather than classifying them as absent", async (error) => {
    const harness = setup();
    harness.post.mockRejectedValueOnce(error);
    await expect(harness.transport.postFinal(delivery, "Synthetic final", identity)).rejects.toBe(
      error,
    );
  });

  it("reconciles only a positive own-bot receipt in the exact requested thread", async () => {
    const harness = setup();
    harness.replies.mockResolvedValueOnce({ ok: true, messages: [message()], has_more: false });
    expect(await harness.transport.reconcile(delivery, identity)).toEqual({
      status: "found",
      messageTs: "100.000003",
    });
    expect(harness.replies).toHaveBeenCalledWith({
      channel: delivery.channelId,
      ts: delivery.threadTs,
      limit: 100,
    });
    harness.replies.mockResolvedValueOnce({ ok: true, messages: [message()], has_more: false });
    await harness.transport.reconcile(delivery, identity);
    expect(harness.auth).toHaveBeenCalledTimes(1);
  });

  it("rejects an authentication team mismatch before reading thread history", async () => {
    const harness = setup();
    expect(await harness.transport.reconcile({ ...delivery, teamId: "T_OTHER" }, identity)).toEqual(
      { status: "unknown", reason: "team_mismatch" },
    );
    expect(harness.replies).not.toHaveBeenCalled();
  });

  it.each([
    { user: "U_OTHER" },
    { bot_id: "B_OTHER" },
    { thread_ts: "200.000001" },
    { ts: "" },
    { ts: "unconfirmed" },
  ])("does not adopt a matching UUID with mismatched identity %j", async (overrides) => {
    const harness = setup();
    harness.replies.mockResolvedValueOnce({
      ok: true,
      messages: [message(overrides)],
      has_more: false,
    });
    expect(await harness.transport.reconcile(delivery, identity)).toMatchObject({
      status: "unknown",
    });
    expect(harness.post).not.toHaveBeenCalled();
  });

  it("never treats complete empty history or a missing UUID as proven absence", async () => {
    const harness = setup();
    expect(await harness.transport.reconcile(delivery, identity)).toEqual({
      status: "unknown",
      reason: "receipt_not_proven",
    });
    harness.replies.mockResolvedValueOnce({
      ok: true,
      messages: [message({ client_msg_id: "00000000-0000-4000-a000-000000000002" })],
      has_more: false,
    });
    expect(await harness.transport.reconcile(delivery, identity)).toMatchObject({
      status: "unknown",
    });
  });

  it("continues through all pages before accepting a unique matching receipt", async () => {
    const harness = setup();
    harness.replies.mockResolvedValueOnce({
      ok: true,
      messages: [message()],
      has_more: true,
      response_metadata: { next_cursor: "synthetic-next" },
    });
    harness.replies.mockResolvedValueOnce({
      ok: true,
      messages: [],
      has_more: false,
      response_metadata: { next_cursor: "" },
    });
    expect(await harness.transport.reconcile(delivery, identity)).toEqual({
      status: "found",
      messageTs: "100.000003",
    });
    expect(harness.replies.mock.calls[1]?.[0]).toMatchObject({ cursor: "synthetic-next" });
  });

  it("does not accept a duplicate UUID found on a later page", async () => {
    const harness = setup();
    harness.replies.mockResolvedValueOnce({
      ok: true,
      messages: [message()],
      has_more: true,
      response_metadata: { next_cursor: "synthetic-next" },
    });
    harness.replies.mockResolvedValueOnce({
      ok: true,
      messages: [message({ ts: "100.000005" })],
      has_more: false,
    });
    expect(await harness.transport.reconcile(delivery, identity)).toEqual({
      status: "unknown",
      reason: "duplicate_identity",
    });
  });

  it("keeps a positive match unknown when history is incomplete", async () => {
    const harness = setup();
    harness.replies.mockResolvedValueOnce({ ok: true, messages: [message()], has_more: true });
    expect(await harness.transport.reconcile(delivery, identity)).toEqual({
      status: "unknown",
      reason: "incomplete_history",
    });
  });

  it("bounds repeated and excessive pagination without adopting an unproven receipt", async () => {
    const repeated = setup();
    repeated.replies.mockResolvedValue({
      ok: true,
      messages: [],
      has_more: true,
      response_metadata: { next_cursor: "synthetic-repeated" },
    });
    expect(await repeated.transport.reconcile(delivery, identity)).toEqual({
      status: "unknown",
      reason: "repeated_cursor",
    });
    const excessive = setup();
    excessive.replies.mockImplementation(async () => ({
      ok: true,
      messages: [],
      has_more: true,
      response_metadata: { next_cursor: `synthetic-page-${excessive.replies.mock.calls.length}` },
    }));
    expect(await excessive.transport.reconcile(delivery, identity)).toEqual({
      status: "unknown",
      reason: "history_limit",
    });
    expect(excessive.replies).toHaveBeenCalledTimes(10);
  });

  it("retries bot-identity discovery after a failed authentication check", async () => {
    const harness = setup();
    harness.auth.mockRejectedValueOnce(new Error("Synthetic auth unavailable"));
    await expect(harness.transport.reconcile(delivery, identity)).rejects.toThrow(
      "auth unavailable",
    );
    harness.replies.mockResolvedValueOnce({ ok: true, messages: [message()], has_more: false });
    expect(await harness.transport.reconcile(delivery, identity)).toMatchObject({
      status: "found",
    });
    expect(harness.auth).toHaveBeenCalledTimes(2);
  });

  it("redacts sensitive final and private question text while binding private replies to the owner", async () => {
    const harness = setup();
    const secret = "xoxb-synthetic-private-value";
    await harness.transport.postFinal(delivery, `Synthetic result ${secret}`, identity);
    await harness.transport.privateInfo({
      channelId: delivery.channelId,
      threadTs: delivery.threadTs,
      userId: delivery.userId,
      text: `Synthetic question ${secret}`,
    });
    expect(harness.post.mock.calls[0]?.[0]).toMatchObject({ text: "Synthetic result [REDACTED]" });
    expect(harness.privatePost).toHaveBeenCalledWith({
      channel: delivery.channelId,
      thread_ts: delivery.threadTs,
      user: delivery.userId,
      text: "Synthetic question [REDACTED]",
    });
    expect(harness.post).toHaveBeenCalledTimes(1);
  });
});
