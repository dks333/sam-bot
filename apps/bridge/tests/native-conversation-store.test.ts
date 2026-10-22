import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  NativeConversationStore,
  hasNativeDelivery,
  nativeConversationSchemaVersion,
  readNativeConversationSchemaVersion,
  type NativeClaim,
} from "../src/persistence/native-conversation-store.js";

const stores: NativeConversationStore[] = [];
const directories: string[] = [];
const claim: NativeClaim = {
  eventId: "synthetic-event",
  teamId: "synthetic-team",
  userId: "synthetic-owner",
  channelId: "synthetic-channel",
  threadTs: "1.0",
  messageTs: "1.1",
  text: "Explain the synthetic source",
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-conversation-store-"));
  directories.push(directory);
  const file = path.join(directory, "native.sqlite");
  const store = new NativeConversationStore(file);
  stores.push(store);
  return { store, file };
}

function reopen(file: string): NativeConversationStore {
  const store = new NativeConversationStore(file);
  stores.push(store);
  return store;
}

describe("NativeConversationStore", () => {
  it("recognizes previously accepted events and messages when changing agent ledgers", () => {
    const { store, file } = setup();
    expect(hasNativeDelivery(file, { eventId: claim.eventId })).toBe(false);
    store.claim(claim);
    expect(hasNativeDelivery(file, { eventId: claim.eventId })).toBe(true);
    expect(
      hasNativeDelivery(file, { channelId: claim.channelId, messageTs: claim.messageTs }),
    ).toBe(true);
    expect(
      hasNativeDelivery(file, { channelId: "synthetic-other-channel", messageTs: claim.messageTs }),
    ).toBe(false);
    expect(hasNativeDelivery(`${file}.absent`, { eventId: claim.eventId })).toBe(false);
  });

  it("reads native schema metadata without changing files and rejects future writers", () => {
    const { file } = setup();
    expect(nativeConversationSchemaVersion).toBe(1);
    expect(readNativeConversationSchemaVersion(file)).toBe(1);
    const raw = new Database(file);
    raw.pragma("user_version = 2");
    raw.close();
    const before = readFileSync(file);
    expect(readNativeConversationSchemaVersion(file)).toBe(2);
    expect(() => new NativeConversationStore(file)).toThrow("newer than this release");
    expect(readFileSync(file)).toEqual(before);
    expect(
      readNativeConversationSchemaVersion(path.join(path.dirname(file), "absent.sqlite")),
    ).toBeUndefined();
  });

  it("claims each Slack event and message once across independent connections", () => {
    const { store, file } = setup();
    const other = reopen(file);
    const first = store.claim(claim);
    expect(first).toMatchObject({ ...claim, state: "queued" });
    expect(other.claim({ ...claim, text: "A redelivered event" })).toBeUndefined();
    expect(
      other.claim({ ...claim, eventId: "another-event", userId: "another-owner" }),
    ).toBeUndefined();
    expect(other.getDelivery(claim.eventId)).toEqual(first);
    expect(store.pendingDeliveries()).toEqual([]);
  });

  it.each(["teamId", "userId", "channelId", "threadTs"])(
    "separates conversations by %s",
    (field) => {
      const { store } = setup();
      const first = store.claim(claim);
      const second = store.claim({
        ...claim,
        [field]: "synthetic-other",
        eventId: "synthetic-other-event",
        messageTs: "2.1",
      });
      if (first === undefined || second === undefined)
        throw new Error("Expected both synthetic claims");
      expect(second.conversationKey).not.toBe(first.conversationKey);
      store.bind(first.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
      expect(store.getConversation(second.conversationKey)?.threadId).toBeUndefined();
      expect(() =>
        store.bind(second.conversationKey, "synthetic-native-thread", "/synthetic/workspace"),
      ).toThrow();
      store.bind(second.conversationKey, "synthetic-other-native-thread", "/synthetic/workspace");
      expect(store.getConversation(first.conversationKey)?.threadId).toBe(
        "synthetic-native-thread",
      );
    },
  );

  it("persists final output and delivery receipts without replaying the native event", () => {
    const { store, file } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected the synthetic claim");
    store.bind(current.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(current.eventId);
    store.started(current.eventId, "synthetic-native-turn");
    store.setProgressReceipt(current.eventId, "1.2");
    store.complete(current.eventId, "The synthetic result", "completed");
    const other = reopen(file);
    expect(other.pendingDeliveries()).toMatchObject([
      {
        eventId: current.eventId,
        finalText: "The synthetic result",
        nativeTurnId: "synthetic-native-turn",
        progressMessageTs: "1.2",
        completionStatus: "completed",
      },
    ]);
    expect(other.getConversation(current.conversationKey)).toMatchObject({
      threadId: "synthetic-native-thread",
      cwd: "/synthetic/workspace",
      state: "idle",
    });
    expect(other.getConversation(current.conversationKey)?.activeTurnId).toBeUndefined();
    other.delivered(current.eventId, "1.2");
    other.delivered(current.eventId, "1.2");
    expect(store.pendingDeliveries()).toEqual([]);
    expect(store.getDelivery(current.eventId)).toMatchObject({
      state: "delivered",
      deliveryMessageTs: "1.2",
      completionStatus: "completed",
    });
    expect(() => store.delivered(current.eventId, "1.3")).toThrow();
    expect(() => store.complete(current.eventId, "Replacement", "completed")).toThrow();
    expect(other.claim(claim)).toBeUndefined();
  });

  it("distinguishes never-dispatched queued work from uncertain native execution after restart", () => {
    const { store, file } = setup();
    const queued = store.claim(claim);
    const dispatching = store.claim({
      ...claim,
      eventId: "synthetic-dispatching",
      threadTs: "2.0",
      messageTs: "2.1",
    });
    const running = store.claim({
      ...claim,
      eventId: "synthetic-running",
      threadTs: "3.0",
      messageTs: "3.1",
    });
    if (queued === undefined || dispatching === undefined || running === undefined)
      throw new Error("Expected synthetic startup states");
    store.dispatch(dispatching.eventId);
    store.dispatch(running.eventId);
    store.started(running.eventId, "synthetic-native-turn");
    const other = reopen(file);
    expect(other.failUncertainOnStartup()).toMatchObject([
      { eventId: queued.eventId, state: "failed", completionStatus: "failed" },
      { eventId: dispatching.eventId, state: "uncertain", completionStatus: "uncertain" },
      {
        eventId: running.eventId,
        state: "uncertain",
        completionStatus: "uncertain",
        nativeTurnId: "synthetic-native-turn",
      },
    ]);
    expect(other.getDelivery(queued.eventId)?.finalText).toContain("before native dispatch");
    expect(other.getConversation(queued.conversationKey)?.state).toBe("idle");
    expect(other.getConversation(running.conversationKey)).toMatchObject({
      state: "uncertain",
      activeTurnId: "synthetic-native-turn",
    });
    expect(other.failUncertainOnStartup()).toEqual([]);
    expect(other.pendingDeliveries()).toHaveLength(3);
    const next = other.claim({
      ...claim,
      eventId: "synthetic-next",
      threadTs: "3.0",
      messageTs: "3.2",
    });
    if (next === undefined) throw new Error("Expected the synthetic follow-up claim");
    expect(() => other.dispatch(next.eventId)).toThrow("cannot dispatch");
    expect(() => other.dispatch(running.eventId)).toThrow("cannot dispatch");
  });

  it("serializes native dispatch and does not clear an active turn when queued work fails", () => {
    const { store } = setup();
    const first = store.claim(claim);
    const next = store.claim({ ...claim, eventId: "synthetic-next", messageTs: "1.2" });
    if (first === undefined || next === undefined) throw new Error("Expected synthetic claims");
    store.bind(first.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(first.eventId);
    store.started(first.eventId, "synthetic-native-turn");
    expect(() => store.dispatch(next.eventId)).toThrow("cannot dispatch");
    store.complete(next.eventId, "Interrupted before dispatch", "failed");
    expect(store.getConversation(first.conversationKey)).toMatchObject({
      state: "running",
      activeTurnId: "synthetic-native-turn",
    });
    expect(() =>
      store.bind(first.conversationKey, "different-native-thread", "/synthetic/workspace"),
    ).toThrow();
    expect(() => store.started(first.eventId, "different-native-turn")).toThrow();
    expect(() => store.delivered(first.eventId, "1.3")).toThrow();
  });

  it("leaves an existing legacy SQLite database unchanged", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "native-legacy-preservation-"));
    directories.push(directory);
    const file = path.join(directory, "legacy.sqlite");
    const legacy = new Database(file);
    legacy.exec(
      "CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(14)",
    );
    legacy.close();
    const before = readFileSync(file);
    expect(() => new NativeConversationStore(file)).toThrow("requires its own database");
    expect(readFileSync(file)).toEqual(before);
  });

  it("reconciles only the exact uncertain native binding without rewriting its delivery history", () => {
    const { store } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected the synthetic claim");
    store.bind(current.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(current.eventId);
    store.started(current.eventId, "synthetic-native-turn");
    expect(
      store.reconcileTerminal(
        current.conversationKey,
        "synthetic-native-thread",
        "synthetic-native-turn",
      ),
    ).toBe(false);
    store.failUncertainOnStartup();
    const history = store.getDelivery(current.eventId);
    expect(
      store.reconcileTerminal(
        "other-conversation",
        "synthetic-native-thread",
        "synthetic-native-turn",
      ),
    ).toBe(false);
    expect(
      store.reconcileTerminal(current.conversationKey, "other-thread", "synthetic-native-turn"),
    ).toBe(false);
    expect(
      store.reconcileTerminal(current.conversationKey, "synthetic-native-thread", "other-turn"),
    ).toBe(false);
    expect(store.getConversation(current.conversationKey)?.state).toBe("uncertain");
    expect(
      store.reconcileTerminal(
        current.conversationKey,
        "synthetic-native-thread",
        "synthetic-native-turn",
      ),
    ).toBe(true);
    expect(store.getConversation(current.conversationKey)).toEqual({
      key: current.conversationKey,
      threadId: "synthetic-native-thread",
      cwd: "/synthetic/workspace",
      state: "idle",
    });
    expect(store.getDelivery(current.eventId)).toEqual(history);
    const next = store.claim({
      ...claim,
      eventId: "synthetic-reconciled-followup",
      messageTs: "1.2",
    });
    if (next === undefined) throw new Error("Expected the synthetic follow-up claim");
    store.dispatch(next.eventId);
    expect(store.getDelivery(next.eventId)?.state).toBe("dispatching");
  });

  it("persists immutable ordered receipts for all final chunks across restart", () => {
    const { store, file } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected the synthetic claim");
    expect(() => store.deliveredPart(current.eventId, 0, "1.2")).toThrow("no persisted final");
    store.dispatch(current.eventId);
    const text = "Synthetic complete native result. ".repeat(1_000);
    store.complete(current.eventId, text, "completed");
    store.deliveredPart(current.eventId, 1, "1.3");
    store.deliveredPart(current.eventId, 0, "1.2");
    const other = reopen(file);
    expect(other.getDeliveryParts(current.eventId)).toEqual([
      { index: 0, messageTs: "1.2" },
      { index: 1, messageTs: "1.3" },
    ]);
    other.deliveredPart(current.eventId, 0, "1.2");
    expect(() => other.deliveredPart(current.eventId, 0, "1.4")).toThrow("receipt changed");
    expect(() => other.deliveredPart(current.eventId, 2, "1.2")).toThrow();
    for (const index of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => other.deliveredPart(current.eventId, index, "1.4")).toThrow(
        "part index is invalid",
      );
    }
    expect(other.getDelivery(current.eventId)?.finalText).toBe(text);
    expect(other.pendingDeliveries()).toHaveLength(1);
    other.delivered(current.eventId, "1.2");
    expect(other.pendingDeliveries()).toEqual([]);
    expect(() => other.deliveredPart(current.eventId, 2, "1.4")).toThrow("cannot gain new parts");
    other.deliveredPart(current.eventId, 1, "1.3");
    expect(other.getDeliveryParts(current.eventId)).toHaveLength(2);
  });

  it.each(["completed", "uncertain"])(
    "keeps the primary turn active when its steering follow-up becomes %s",
    (status) => {
      const { store } = setup();
      const primary = store.claim(claim);
      const followup = store.claim({
        ...claim,
        eventId: "synthetic-steering-followup",
        messageTs: "1.2",
      });
      if (primary === undefined || followup === undefined)
        throw new Error("Expected synthetic claims");
      store.bind(primary.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
      store.dispatch(primary.eventId);
      store.started(primary.eventId, "synthetic-native-turn");
      const active = store.getConversation(primary.conversationKey);
      expect(() => store.steering(followup.eventId, "other-turn")).toThrow("does not match");
      store.steering(followup.eventId, "synthetic-native-turn");
      expect(store.getDelivery(followup.eventId)).toMatchObject({
        state: "dispatching",
        nativeTurnId: "synthetic-native-turn",
      });
      expect(store.getConversation(primary.conversationKey)).toEqual(active);
      expect(() => store.steered(followup.eventId, "other-turn")).toThrow("no longer matches");
      store.steered(followup.eventId, "synthetic-native-turn");
      let completion: "completed" | "uncertain" = "completed";
      if (status === "uncertain") completion = "uncertain";
      store.complete(followup.eventId, "Synthetic follow-up result", completion);
      expect(store.getConversation(primary.conversationKey)).toEqual(active);
      store.complete(primary.eventId, "Synthetic terminal primary result", "completed");
      expect(store.getConversation(primary.conversationKey)?.state).toBe("idle");
      expect(store.getDelivery(followup.eventId)?.completionStatus).toBe(completion);
      expect(store.pendingDeliveries()).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "links an accepted steering follow-up to the actual primary final receipt, late acknowledgement: %s",
    (late) => {
      const { store, file } = setup();
      const primary = store.claim(claim);
      const followup = store.claim({
        ...claim,
        eventId: "synthetic-linked-followup",
        messageTs: "1.2",
      });
      if (primary === undefined || followup === undefined)
        throw new Error("Expected synthetic claims");
      store.bind(primary.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
      store.dispatch(primary.eventId);
      store.started(primary.eventId, "synthetic-native-turn");
      store.steering(followup.eventId, "synthetic-native-turn");
      if (late) {
        store.complete(primary.eventId, "Complete native result", "completed");
        store.delivered(primary.eventId, "1.9");
      }
      store.linkFollowup(followup.eventId, primary.eventId);
      if (!late) {
        store.complete(primary.eventId, "Complete native result", "completed");
        expect(store.getDelivery(followup.eventId)).toMatchObject({
          rootEventId: primary.eventId,
          finalText: "Complete native result",
          state: "completed",
        });
        expect(store.getDelivery(followup.eventId)?.deliveryMessageTs).toBeUndefined();
        expect(store.pendingDeliveries().map((item) => item.eventId)).toEqual([primary.eventId]);
        store.delivered(primary.eventId, "1.9");
      }
      const other = reopen(file);
      expect(other.getDelivery(followup.eventId)).toMatchObject({
        rootEventId: primary.eventId,
        finalText: "Complete native result",
        state: "delivered",
        deliveryMessageTs: "1.9",
      });
      expect(other.pendingDeliveries()).toEqual([]);
      other.linkFollowup(followup.eventId, primary.eventId);
      expect(other.getDelivery(followup.eventId)?.deliveryMessageTs).not.toBe(followup.messageTs);
      expect(
        other.claim({ ...claim, eventId: followup.eventId, messageTs: followup.messageTs }),
      ).toBeUndefined();
    },
  );

  it("rejects cross-owner, cross-turn and chained steering delivery links", () => {
    const { store } = setup();
    const primary = store.claim(claim);
    const followup = store.claim({
      ...claim,
      eventId: "synthetic-linked-followup",
      messageTs: "1.2",
    });
    const next = store.claim({ ...claim, eventId: "synthetic-next-followup", messageTs: "1.3" });
    const foreign = store.claim({
      ...claim,
      eventId: "synthetic-foreign-followup",
      userId: "other-owner",
      messageTs: "2.1",
    });
    if (
      primary === undefined ||
      followup === undefined ||
      next === undefined ||
      foreign === undefined
    )
      throw new Error("Expected synthetic claims");
    store.bind(primary.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.bind(foreign.conversationKey, "synthetic-foreign-thread", "/synthetic/workspace");
    store.dispatch(primary.eventId);
    store.started(primary.eventId, "synthetic-native-turn");
    store.dispatch(foreign.eventId);
    store.started(foreign.eventId, "synthetic-native-turn");
    expect(() => store.linkFollowup(foreign.eventId, primary.eventId)).toThrow("does not match");
    expect(() => store.linkFollowup(primary.eventId, primary.eventId)).toThrow("does not match");
    expect(() => store.linkFollowup(followup.eventId, primary.eventId)).toThrow("does not match");
    store.steering(followup.eventId, "synthetic-native-turn");
    store.linkFollowup(followup.eventId, primary.eventId);
    store.steering(next.eventId, "synthetic-native-turn");
    expect(() => store.linkFollowup(next.eventId, followup.eventId)).toThrow("does not match");
    expect(store.getDelivery(next.eventId)?.rootEventId).toBeUndefined();
  });

  it("does not link a new accepted follow-up to a previous turn in the same conversation", () => {
    const { store } = setup();
    const previous = store.claim(claim);
    if (previous === undefined) throw new Error("Expected the synthetic previous claim");
    store.bind(previous.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(previous.eventId);
    store.started(previous.eventId, "synthetic-previous-turn");
    store.complete(previous.eventId, "Previous native result", "completed");
    const current = store.claim({ ...claim, eventId: "synthetic-current", messageTs: "1.2" });
    const followup = store.claim({
      ...claim,
      eventId: "synthetic-current-followup",
      messageTs: "1.3",
    });
    if (current === undefined || followup === undefined)
      throw new Error("Expected synthetic current claims");
    store.dispatch(current.eventId);
    store.started(current.eventId, "synthetic-current-turn");
    store.steering(followup.eventId, "synthetic-current-turn");
    expect(() => store.linkFollowup(followup.eventId, previous.eventId)).toThrow("does not match");
    expect(store.getDelivery(followup.eventId)?.rootEventId).toBeUndefined();
  });

  it("never claims that a primary Slack receipt delivered different follow-up content", () => {
    const { store } = setup();
    const primary = store.claim(claim);
    const followup = store.claim({ ...claim, eventId: "synthetic-followup", messageTs: "1.2" });
    if (primary === undefined || followup === undefined)
      throw new Error("Expected synthetic claims");
    store.bind(primary.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(primary.eventId);
    store.started(primary.eventId, "synthetic-native-turn");
    store.steering(followup.eventId, "synthetic-native-turn");
    store.linkFollowup(followup.eventId, primary.eventId);
    store.complete(followup.eventId, "Different follow-up content", "failed");
    store.complete(primary.eventId, "Primary native result", "completed");
    expect(() => store.delivered(primary.eventId, "1.9")).toThrow(
      "differs from its primary delivery",
    );
    expect(store.getDelivery(primary.eventId)?.deliveryMessageTs).toBeUndefined();
    expect(store.getDelivery(followup.eventId)?.deliveryMessageTs).toBeUndefined();
  });

  it("persists immutable final intent identities before sending and confirms only complete output", () => {
    const { store, file } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected a synthetic claim");
    expect(() => store.prepareFinalParts(current.eventId, ["Synthetic result"])).toThrow(
      "persisted native final",
    );
    store.dispatch(current.eventId);
    store.complete(current.eventId, "Synthetic result", "completed");
    const parts = store.prepareFinalParts(current.eventId, ["Synthetic ", "result"]);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.id).not.toBe(parts[1]?.id);
    expect(parts.every((part) => part.state === "pending")).toBe(true);
    expect(() => store.confirmFinalPart(current.eventId, 0, "2.1")).toThrow("no attempted send");
    expect(() => store.delivered(current.eventId, "2.1")).toThrow("not all confirmed");
    const attempted = store.beginFinalPart(current.eventId, 0);
    expect(attempted).toMatchObject({
      id: parts[0]?.id,
      state: "sending",
      attemptedAt: expect.any(String),
    });
    const other = reopen(file);
    expect(other.prepareFinalParts(current.eventId, ["Synthetic ", "result"])).toEqual(
      store.getFinalParts(current.eventId),
    );
    expect(() => other.prepareFinalParts(current.eventId, ["Synthetic result"])).toThrow(
      "cannot change",
    );
    other.confirmFinalPart(current.eventId, 0, "2.1");
    expect(() => other.delivered(current.eventId, "2.1")).toThrow("not all confirmed");
    other.beginFinalPart(current.eventId, 1);
    other.confirmFinalPart(current.eventId, 1, "2.2");
    expect(() => other.confirmFinalPart(current.eventId, 0, "2.3")).toThrow("receipt changed");
    expect(() => other.delivered(current.eventId, "2.1")).toThrow("not all confirmed");
    other.delivered(current.eventId, "2.2");
    expect(store.getDelivery(current.eventId)?.state).toBe("delivered");
  });

  it("adopts old final receipts and keeps a legacy progress target distinct from confirmed output", () => {
    const { store } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected a synthetic claim");
    store.dispatch(current.eventId);
    store.setProgressReceipt(current.eventId, "1.9");
    store.complete(current.eventId, "Synthetic result", "completed");
    store.deliveredPart(current.eventId, 1, "2.2");
    expect(store.prepareFinalParts(current.eventId, ["Synthetic ", "result"])).toMatchObject([
      { index: 0, state: "pending", messageTs: "1.9" },
      { index: 1, state: "confirmed", messageTs: "2.2" },
    ]);
    expect(() => store.prepareFinalParts(current.eventId, ["Unrelated result"])).toThrow(
      "do not match",
    );
  });

  it("marks interrupted final sends uncertain while retaining stable identity and completed execution", () => {
    const { store, file } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected a synthetic claim");
    store.dispatch(current.eventId);
    store.complete(current.eventId, "Synthetic result", "completed");
    store.prepareFinalParts(current.eventId, ["Synthetic result"]);
    const attempted = store.beginFinalPart(current.eventId, 0);
    const other = reopen(file);
    other.failUncertainOnStartup();
    expect(other.getFinalParts(current.eventId)[0]).toMatchObject({
      state: "uncertain",
      id: attempted.id,
      attemptedAt: attempted.attemptedAt,
    });
    expect(other.getConversation(current.conversationKey)?.state).toBe("idle");
    expect(other.getDelivery(current.eventId)?.completionStatus).toBe("completed");
    other.retryFinalPart(current.eventId, 0);
    expect(other.beginFinalPart(current.eventId, 0)).toMatchObject({
      id: attempted.id,
      attemptedAt: attempted.attemptedAt,
    });
    expect(() => other.retryFinalPart(current.eventId, 0, -1)).toThrow("retry delay");
  });

  it("adds native delivery tables without replacing old conversation history", () => {
    const { store, file } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected a synthetic claim");
    store.dispatch(current.eventId);
    store.complete(current.eventId, "Historical synthetic result", "completed");
    store.deliveredPart(current.eventId, 0, "1.9");
    const before = store.getDelivery(current.eventId);
    const raw = new Database(file);
    raw.exec("DROP TABLE native_final_delivery_intents; DROP TABLE native_unadmitted_steers");
    raw.pragma("user_version = 0");
    raw.close();
    const other = reopen(file);
    expect(readNativeConversationSchemaVersion(file)).toBe(1);
    expect(other.getDelivery(current.eventId)).toEqual(before);
    expect(other.getDeliveryParts(current.eventId)).toEqual([{ index: 0, messageTs: "1.9" }]);
    expect(
      other.prepareFinalParts(current.eventId, ["Historical synthetic result"])[0],
    ).toMatchObject({ state: "confirmed", messageTs: "1.9" });
  });

  it("retains only proven unadmitted steering across restart and consumes proof on dispatch", () => {
    const { store, file } = setup();
    const primary = store.claim(claim);
    const retained = store.claim({
      ...claim,
      eventId: "synthetic-retained-steer",
      messageTs: "1.2",
      text: "Keep the synthetic follow-up instruction",
    });
    const unknown = store.claim({ ...claim, eventId: "synthetic-unknown-steer", messageTs: "1.3" });
    if (primary === undefined || retained === undefined || unknown === undefined)
      throw new Error("Expected synthetic claims");
    store.bind(primary.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(primary.eventId);
    store.started(primary.eventId, "synthetic-native-turn");
    store.steering(retained.eventId, "synthetic-native-turn");
    store.steering(unknown.eventId, "synthetic-native-turn");
    expect(() => store.markUnadmitted(retained.eventId, "foreign-turn")).toThrow(
      "proven unadmitted",
    );
    store.markUnadmitted(retained.eventId, "synthetic-native-turn");
    expect(() => store.retryUnadmitted(retained.eventId, "synthetic-native-turn")).toThrow(
      "before its original turn terminates",
    );
    const other = reopen(file);
    other.failUncertainOnStartup();
    expect(other.getDelivery(unknown.eventId)?.completionStatus).toBe("uncertain");
    expect(other.listUnadmitted()).toMatchObject([
      {
        eventId: retained.eventId,
        state: "dispatching",
        text: "Keep the synthetic follow-up instruction",
        unadmittedTurnId: "synthetic-native-turn",
      },
    ]);
    expect(
      other.reconcileTerminal(
        primary.conversationKey,
        "synthetic-native-thread",
        "synthetic-native-turn",
      ),
    ).toBe(true);
    other.retryUnadmitted(retained.eventId, "synthetic-native-turn");
    other.failUncertainOnStartup();
    expect(other.getDelivery(retained.eventId)).toMatchObject({
      state: "queued",
      unadmittedTurnId: "synthetic-native-turn",
    });
    other.dispatch(retained.eventId);
    expect(other.listUnadmitted()).toEqual([]);
    expect(other.getDelivery(retained.eventId)?.unadmittedTurnId).toBeUndefined();
    expect(other.getDelivery(primary.eventId)?.completionStatus).toBe("uncertain");
  });

  it("does not mark accepted or terminal steering as proven unadmitted", () => {
    const { store } = setup();
    const primary = store.claim(claim);
    const follower = store.claim({
      ...claim,
      eventId: "synthetic-accepted-followup",
      messageTs: "1.2",
    });
    if (primary === undefined || follower === undefined)
      throw new Error("Expected synthetic claims");
    store.bind(primary.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(primary.eventId);
    store.started(primary.eventId, "synthetic-native-turn");
    store.steering(follower.eventId, "synthetic-native-turn");
    store.linkFollowup(follower.eventId, primary.eventId);
    expect(() => store.markUnadmitted(follower.eventId, "synthetic-native-turn")).toThrow();
    store.complete(primary.eventId, "Synthetic complete result", "completed");
    expect(() => store.markUnadmitted(primary.eventId, "synthetic-native-turn")).toThrow();
  });

  it("lists recovery conversation identities and deliveries within their exact owner binding", () => {
    const { store } = setup();
    const first = store.claim(claim);
    const other = store.claim({
      ...claim,
      eventId: "synthetic-other-owner",
      userId: "synthetic-other-owner",
      messageTs: "2.1",
    });
    if (first === undefined || other === undefined) throw new Error("Expected synthetic claims");
    expect(store.listConversations()).toMatchObject([
      {
        key: first.conversationKey,
        teamId: claim.teamId,
        userId: claim.userId,
        channelId: claim.channelId,
        threadTs: claim.threadTs,
      },
      { key: other.conversationKey, userId: "synthetic-other-owner" },
    ]);
    expect(
      store.listDeliveriesForConversation(first.conversationKey).map((item) => item.eventId),
    ).toEqual([first.eventId]);
    expect(
      store.listDeliveriesForConversation(other.conversationKey).map((item) => item.eventId),
    ).toEqual([other.eventId]);
  });
});
