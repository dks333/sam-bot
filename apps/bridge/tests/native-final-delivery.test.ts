import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NativeFinalDelivery,
  NativeFinalNotSentError,
  splitNativeResponse,
  type NativeFinalDeliveryTransport,
} from "../src/bridge/native-final-delivery.js";
import {
  NativeConversationStore,
  type NativeCompletionStatus,
  type NativeFinalReconciliation,
} from "../src/persistence/native-conversation-store.js";

const stores: NativeConversationStore[] = [];
const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(
  text = "The synthetic final result",
  progressReceipt?: string,
  completionStatus: NativeCompletionStatus = "completed",
) {
  const directory = mkdtempSync(path.join(tmpdir(), "native-final-delivery-"));
  directories.push(directory);
  const file = path.join(directory, "native.sqlite");
  const store = new NativeConversationStore(file);
  stores.push(store);
  const current = store.claim({
    eventId: "synthetic-event",
    teamId: "synthetic-team",
    userId: "synthetic-owner",
    channelId: "synthetic-channel",
    threadTs: "1.0",
    messageTs: "1.1",
    text: "Investigate the synthetic fixture",
  });
  if (current === undefined) throw new Error("Expected a synthetic delivery");
  store.bind(current.conversationKey, "synthetic-native-thread", "/synthetic/project");
  store.dispatch(current.eventId);
  store.started(current.eventId, "synthetic-native-turn");
  if (progressReceipt !== undefined) store.setProgressReceipt(current.eventId, progressReceipt);
  store.complete(current.eventId, text, completionStatus);
  const postFinal = vi.fn(async () => "2.1");
  const update = vi.fn(async () => {});
  const reconcile = vi.fn(async (): Promise<NativeFinalReconciliation> => ({ status: "unknown" }));
  const setMessageStatus = vi.fn<NativeFinalDeliveryTransport["setMessageStatus"]>(async () => {});
  const transport = { postFinal, update, reconcile, setMessageStatus };
  const logger = { info: vi.fn(), warn: vi.fn() };
  let owned = true;
  const assertOwned = () => {
    if (!owned) throw new Error("Synthetic runtime is no longer owned");
  };
  const delivery = new NativeFinalDelivery({ store, transport, logger, assertOwned });
  return {
    store,
    file,
    current,
    postFinal,
    update,
    reconcile,
    setMessageStatus,
    transport,
    logger,
    delivery,
    assertOwned,
    loseOwnership() {
      owned = false;
    },
  };
}

describe("NativeFinalDelivery", () => {
  it("posts a separate final with a durable send intent and saves the actual receipt", async () => {
    const harness = setup();
    harness.postFinal.mockImplementationOnce(async () => {
      expect(harness.store.getFinalParts(harness.current.eventId)).toMatchObject([
        { state: "sending", text: "The synthetic final result", attemptedAt: expect.any(String) },
      ]);
      expect(harness.store.getConversation(harness.current.conversationKey)?.state).toBe("idle");
      return "2.9";
    });
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.store.getDelivery(harness.current.eventId)).toMatchObject({
      completionStatus: "completed",
      deliveryMessageTs: "2.9",
      state: "delivered",
    });
    expect(harness.postFinal).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: harness.current.eventId }),
      "The synthetic final result",
      expect.objectContaining({ id: expect.any(String), part: 0, contentHash: expect.any(String) }),
    );
    expect(harness.setMessageStatus).toHaveBeenCalledWith(
      { channelId: "synthetic-channel", messageTs: "1.1" },
      "completed",
      "working",
    );
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    expect(harness.setMessageStatus).toHaveBeenCalledTimes(1);
  });

  it("retries a failed terminal reaction after restart without reposting the confirmed final", async () => {
    const harness = setup();
    harness.setMessageStatus.mockImplementationOnce(async () => {
      expect(harness.store.getFinalParts(harness.current.eventId)[0]?.state).toBe("confirmed");
      throw new Error("Synthetic reaction outage");
    });
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.store.pendingDeliveries()).toHaveLength(1);
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBeUndefined();
    const recovered = new NativeConversationStore(harness.file);
    stores.push(recovered);
    recovered.failUncertainOnStartup();
    const delivery = new NativeFinalDelivery({
      store: recovered,
      transport: harness.transport,
      logger: harness.logger,
      assertOwned: harness.assertOwned,
    });
    await delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    expect(harness.setMessageStatus).toHaveBeenCalledTimes(2);
    expect(recovered.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBe("2.1");
    expect(recovered.pendingDeliveries()).toEqual([]);
  });

  it("marks a failed native completion as failed after its result is confirmed", async () => {
    const harness = setup("Synthetic execution failed", undefined, "failed");
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.setMessageStatus).toHaveBeenCalledWith(
      { channelId: "synthetic-channel", messageTs: "1.1" },
      "failed",
      "working",
    );
  });

  it("marks an uncertain native completion as waiting after its result is confirmed", async () => {
    const harness = setup("Synthetic execution needs reconciliation", undefined, "uncertain");
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.setMessageStatus).toHaveBeenCalledWith(
      { channelId: "synthetic-channel", messageTs: "1.1" },
      "waiting",
      "working",
    );
  });

  it("does not blindly repost a fresh send whose remote outcome is unknown", async () => {
    const harness = setup();
    harness.postFinal.mockRejectedValueOnce(new Error("Synthetic accepted write lost its reply"));
    await harness.delivery.deliver(harness.current.eventId);
    const part = harness.store.getFinalParts(harness.current.eventId)[0];
    expect(part?.state).toBe("uncertain");
    expect(harness.store.getDelivery(harness.current.eventId)?.completionStatus).toBe("completed");
    await harness.delivery.deliver(harness.current.eventId);
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    expect(harness.reconcile).toHaveBeenCalledTimes(2);
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBeUndefined();
    expect(harness.setMessageStatus).not.toHaveBeenCalled();
  });

  it("adopts exactly reconciled remote output without posting again", async () => {
    const harness = setup();
    harness.postFinal.mockRejectedValueOnce(new Error("Synthetic lost acknowledgement"));
    await harness.delivery.deliver(harness.current.eventId);
    const original = harness.store.getFinalParts(harness.current.eventId)[0];
    harness.reconcile.mockResolvedValueOnce({ status: "found", messageTs: "2.8" });
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "synthetic-channel", threadTs: "1.0" }),
      expect.objectContaining({ id: original?.id, attemptedAt: original?.attemptedAt }),
    );
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBe("2.8");
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
  });

  it("requires explicit absence proof before returning a part to pending", async () => {
    const harness = setup();
    harness.postFinal.mockRejectedValueOnce(new Error("Synthetic interrupted response"));
    await harness.delivery.deliver(harness.current.eventId);
    const original = harness.store.getFinalParts(harness.current.eventId)[0];
    harness.reconcile.mockResolvedValueOnce({ status: "absent" });
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.store.getFinalParts(harness.current.eventId)[0]?.state).toBe("pending");
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(2);
    expect(harness.store.getFinalParts(harness.current.eventId)[0]).toMatchObject({
      id: original?.id,
      attemptedAt: original?.attemptedAt,
    });
  });

  it("keeps an unavailable reconciliation uncertain", async () => {
    const harness = setup();
    harness.postFinal.mockRejectedValueOnce(new Error("Synthetic timeout"));
    await harness.delivery.deliver(harness.current.eventId);
    harness.reconcile.mockRejectedValueOnce(new Error("Synthetic unavailable thread history"));
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.store.getFinalParts(harness.current.eventId)[0]?.state).toBe("uncertain");
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
  });

  it("reconciles a persisted in-flight part after restart before sending", async () => {
    const harness = setup();
    const original = harness.store.prepareFinalParts(harness.current.eventId, [
      "The synthetic final result",
    ])[0];
    harness.store.beginFinalPart(harness.current.eventId, 0);
    const recovered = new NativeConversationStore(harness.file);
    stores.push(recovered);
    recovered.failUncertainOnStartup();
    harness.reconcile.mockResolvedValueOnce({ status: "found", messageTs: "2.7" });
    const delivery = new NativeFinalDelivery({
      store: recovered,
      transport: harness.transport,
      logger: harness.logger,
      assertOwned: harness.assertOwned,
    });
    await delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).not.toHaveBeenCalled();
    expect(recovered.getFinalParts(harness.current.eventId)[0]).toMatchObject({
      id: original?.id,
      state: "confirmed",
      messageTs: "2.7",
    });
  });

  it("preserves the final across a receipt persistence failure", async () => {
    const harness = setup();
    vi.spyOn(harness.store, "confirmFinalPart").mockImplementationOnce(() => {
      throw new Error("Synthetic interrupted receipt write");
    });
    await expect(harness.delivery.deliver(harness.current.eventId)).rejects.toThrow(
      "interrupted receipt",
    );
    expect(harness.store.getFinalParts(harness.current.eventId)[0]?.state).toBe("sending");
    harness.reconcile.mockResolvedValueOnce({ status: "found", messageTs: "2.1" });
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBe("2.1");
  });

  it("updates an old progress receipt without creating a fresh final", async () => {
    const harness = setup("The synthetic final result", "1.9");
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).not.toHaveBeenCalled();
    expect(harness.update).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: harness.current.eventId }),
      "1.9",
      "The synthetic final result",
    );
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBe("1.9");
  });

  it("retries an ambiguous known-message update at the same receipt", async () => {
    const harness = setup("The synthetic final result", "1.9");
    harness.update.mockRejectedValueOnce(new Error("Synthetic lost update response"));
    await harness.delivery.deliver(harness.current.eventId);
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.update).toHaveBeenCalledTimes(2);
    expect(harness.postFinal).not.toHaveBeenCalled();
    expect(harness.reconcile).not.toHaveBeenCalled();
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBe("1.9");
  });

  it("resumes multipart output without duplicating confirmed parts", async () => {
    const harness = setup("a".repeat(60_001));
    harness.postFinal
      .mockResolvedValueOnce("2.1")
      .mockRejectedValueOnce(new Error("Synthetic second-part response lost"))
      .mockResolvedValueOnce("2.3");
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.store.getFinalParts(harness.current.eventId).map((part) => part.state)).toEqual([
      "confirmed",
      "uncertain",
      "pending",
    ]);
    expect(harness.setMessageStatus).not.toHaveBeenCalled();
    harness.reconcile.mockResolvedValueOnce({ status: "found", messageTs: "2.2" });
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(3);
    expect(harness.store.getDeliveryParts(harness.current.eventId)).toEqual([
      { index: 0, messageTs: "2.1" },
      { index: 1, messageTs: "2.2" },
      { index: 2, messageTs: "2.3" },
    ]);
    expect(harness.store.getDelivery(harness.current.eventId)?.deliveryMessageTs).toBe("2.3");
  });

  it("does not persist late network results after runtime ownership is lost", async () => {
    const harness = setup();
    harness.postFinal.mockImplementationOnce(async () => {
      harness.loseOwnership();
      return "2.1";
    });
    await expect(harness.delivery.deliver(harness.current.eventId)).rejects.toThrow(
      "no longer owned",
    );
    expect(harness.store.getDeliveryParts(harness.current.eventId)).toEqual([]);
    expect(harness.store.getFinalParts(harness.current.eventId)[0]?.state).toBe("sending");
  });

  it("coalesces concurrent final delivery calls", async () => {
    const harness = setup();
    let finish = () => {};
    harness.postFinal.mockImplementationOnce(
      async () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("2.1");
        }),
    );
    const first = harness.delivery.deliver(harness.current.eventId);
    const duplicate = harness.delivery.deliver(harness.current.eventId);
    expect(first).toBe(duplicate);
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(harness.store.pendingDeliveries()).toEqual([]);
  });

  it("respects a proven non-send retry delay without requiring reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const harness = setup();
    harness.postFinal.mockRejectedValueOnce(
      new NativeFinalNotSentError("Synthetic rate limit", 60_000),
    );
    await harness.delivery.deliver(harness.current.eventId);
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(1);
    expect(harness.reconcile).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2030-01-01T00:01:00.000Z"));
    await harness.delivery.deliver(harness.current.eventId);
    expect(harness.postFinal).toHaveBeenCalledTimes(2);
    expect(harness.store.getDelivery(harness.current.eventId)?.state).toBe("delivered");
  });

  it("preserves surrogate pairs and every final character when splitting", () => {
    const text = `${"a".repeat(29_999)}😀${"b".repeat(30_000)}`;
    const parts = splitNativeResponse(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 30_000)).toBe(true);
    expect(parts[0]?.endsWith("\ud83d")).toBe(false);
    expect(splitNativeResponse("")).toEqual(["Codex completed without a final response."]);
  });
});
