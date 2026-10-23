import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeFinalDelivery } from "../src/bridge/native-final-delivery.js";
import {
  NativeConversationStore,
  type NativeDelivery,
} from "../src/persistence/native-conversation-store.js";
import { nativeSlackTransport } from "../src/slack/native-transport.js";
import { redactSensitiveText } from "../src/slack/redact-sensitive.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function setupTransport(values: readonly string[] = []) {
  const client = new WebClient("synthetic-test-credential");
  let sequence = 2;
  const post = vi.spyOn(client.chat, "postMessage").mockImplementation(async () => {
    sequence += 1;
    return { ok: true, channel: "C_SYNTHETIC", ts: `100.${String(sequence).padStart(6, "0")}` };
  });
  const update = vi.spyOn(client.chat, "update").mockResolvedValue({
    ok: true,
    channel: "C_SYNTHETIC",
    ts: "100.000003",
  });
  const privatePost = vi
    .spyOn(client.chat, "postEphemeral")
    .mockResolvedValue({ ok: true, message_ts: "100.000004" });
  vi.spyOn(client.reactions, "add").mockResolvedValue({ ok: true });
  vi.spyOn(client.reactions, "remove").mockResolvedValue({ ok: true });
  const redactText = (text: string) => redactSensitiveText(text, values);
  return {
    post,
    update,
    privatePost,
    redactText,
    transport: nativeSlackTransport(client, redactText),
  };
}

function setupDelivery(text: string, values: readonly string[] = []) {
  const directory = mkdtempSync(path.join(tmpdir(), "synthetic-security-egress-"));
  const store = new NativeConversationStore(path.join(directory, "native.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const delivery = store.claim({
    eventId: "synthetic-security-event",
    teamId: "T_SYNTHETIC",
    userId: "U_SYNTHETIC_OWNER",
    channelId: "C_SYNTHETIC",
    threadTs: "100.000001",
    messageTs: "100.000002",
    text: "Inspect the synthetic fixture",
  });
  if (delivery === undefined) throw new Error("Expected a synthetic delivery");
  store.bind(delivery.conversationKey, "synthetic-thread", "/synthetic/project");
  store.dispatch(delivery.eventId);
  store.started(delivery.eventId, "synthetic-turn");
  store.complete(delivery.eventId, text, "completed");
  const harness = setupTransport(values);
  const final = new NativeFinalDelivery({
    store,
    transport: harness.transport,
    logger: { info: vi.fn(), warn: vi.fn() },
    assertOwned: () => {},
    redactSensitiveText: harness.redactText,
  });
  return { ...harness, store, delivery, final };
}

function completedDelivery(store: NativeConversationStore, eventId: string): NativeDelivery {
  const delivery = store.getDelivery(eventId);
  if (delivery === undefined) throw new Error("Expected the persisted synthetic result");
  return delivery;
}

function postedText(harness: ReturnType<typeof setupTransport>): string {
  return harness.post.mock.calls
    .map(([input]) => {
      if (!("text" in input) || typeof input.text !== "string") {
        throw new Error("Expected a textual Slack response");
      }
      return input.text;
    })
    .join("");
}

describe("Secret-safe Slack delivery", () => {
  it("filters complete JSON secrets before splitting a result across messages", async () => {
    const text = `${"a".repeat(29_998)}{"password":"synthetic-private-password"}`;
    const harness = setupDelivery(text);

    await harness.final.deliver(harness.delivery.eventId);

    const posted = postedText(harness);
    expect(posted).toBe(harness.redactText(text));
    expect(posted).not.toContain("synthetic-private-password");
    expect(posted).toContain("[REDACTED]");
    expect(
      harness.store
        .getFinalParts(harness.delivery.eventId)
        .map((part) => part.text)
        .join(""),
    ).toBe(harness.redactText(text));
    expect(harness.store.getDelivery(harness.delivery.eventId)?.finalText).toBe(text);
    expect(harness.store.getDelivery(harness.delivery.eventId)?.state).toBe("delivered");
  });

  it("filters configured values across a message boundary without losing delivery identity", async () => {
    const value = "synthetic-unlabelled-private-value";
    const text = `${"b".repeat(29_990)}${value}${"c".repeat(30_010)}`;
    const harness = setupDelivery(text, [value]);

    await harness.final.deliver(harness.delivery.eventId);

    const posted = postedText(harness);
    expect(posted).toBe(harness.redactText(text));
    expect(posted).not.toContain(value);
    expect(harness.store.getFinalParts(harness.delivery.eventId)).toHaveLength(3);
    expect(
      harness.store
        .getFinalParts(harness.delivery.eventId)
        .every((part) => part.state === "confirmed"),
    ).toBe(true);
    await harness.final.deliver(harness.delivery.eventId);
    expect(harness.post).toHaveBeenCalledTimes(3);
  });

  it("refuses to silently replace previously prepared unsafe delivery parts", async () => {
    const text = '{"password":"synthetic-legacy-password"}';
    const harness = setupDelivery(text);
    harness.store.prepareFinalParts(harness.delivery.eventId, [text]);

    await expect(harness.final.deliver(harness.delivery.eventId)).rejects.toThrow(
      "delivery content cannot change",
    );

    expect(harness.post).not.toHaveBeenCalled();
    expect(harness.store.getFinalParts(harness.delivery.eventId)[0]?.text).toBe(text);
  });

  it("uses the same configured-value policy for posts, updates and private messages", async () => {
    const value = "synthetic-unlabelled-credential";
    const harness = setupDelivery("Synthetic result", [value]);
    const delivery = completedDelivery(harness.store, harness.delivery.eventId);
    const text = `Diagnostic: ${value}; Authorization: Bearer synthetic-bearer-value`;

    await harness.transport.post(delivery, text, 0);
    await harness.transport.postFinal(delivery, text, {
      id: "00000000-0000-4000-a000-000000000001",
      part: 0,
      contentHash: "a".repeat(64),
      attemptedAt: "2030-01-01T00:00:01.000Z",
    });
    await harness.transport.update(delivery, "100.000003", text);
    await harness.transport.info({
      channelId: delivery.channelId,
      threadTs: delivery.threadTs,
      text,
    });
    await harness.transport.privateInfo({
      channelId: delivery.channelId,
      threadTs: delivery.threadTs,
      userId: delivery.userId,
      text,
    });

    const sent = JSON.stringify([
      harness.post.mock.calls,
      harness.update.mock.calls,
      harness.privatePost.mock.calls,
    ]);
    expect(sent).not.toContain(value);
    expect(sent).not.toContain("synthetic-bearer-value");
    expect(sent).toContain("[REDACTED]");
    expect(harness.post).toHaveBeenCalledTimes(3);
    expect(harness.update).toHaveBeenCalledOnce();
    expect(harness.privatePost).toHaveBeenCalledOnce();
  });
});
