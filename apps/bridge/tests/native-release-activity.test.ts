import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { assertRuntimeIdle, runtimeActivity } from "../src/cli/release-manager.js";
import { NativeConversationStore } from "../src/persistence/native-conversation-store.js";

const directories: string[] = [];
const stores: NativeConversationStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-release-activity-"));
  directories.push(directory);
  const databaseFile = path.join(directory, "bridge.sqlite");
  const nativeFile = path.join(directory, "native-conversations.sqlite");
  const store = new NativeConversationStore(nativeFile);
  stores.push(store);
  return { databaseFile, nativeFile, store };
}

function claim(store: NativeConversationStore, eventId: string, threadTs = "1.0") {
  const current = store.claim({
    eventId,
    teamId: "synthetic-team",
    userId: "synthetic-owner",
    channelId: "synthetic-channel",
    threadTs,
    messageTs: eventId,
    text: "Explain the synthetic source",
  });
  if (current === undefined) throw new Error("Expected the synthetic claim");
  return current;
}

describe("native transport release activity", () => {
  it("blocks queued native requests even when the legacy database does not exist", () => {
    const { databaseFile, store } = setup();
    claim(store, "synthetic-queued");
    expect(runtimeActivity(databaseFile)).toMatchObject({
      schemaVersion: 0,
      queuedTasks: 1,
      activeRuns: 0,
    });
    expect(() => assertRuntimeIdle(databaseFile)).toThrow("Refusing");
    expect(existsSync(databaseFile)).toBe(false);
  });

  it("adds native dispatching and running work to existing legacy counts without migrations", () => {
    const { databaseFile, store } = setup();
    const database = new Database(databaseFile);
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(14); CREATE TABLE active_runs(event_id TEXT); INSERT INTO active_runs VALUES('synthetic-legacy-active')",
    );
    database.close();
    const before = readFileSync(databaseFile);
    const dispatching = claim(store, "synthetic-dispatching");
    const running = claim(store, "synthetic-running", "2.0");
    store.dispatch(dispatching.eventId);
    store.dispatch(running.eventId);
    store.started(running.eventId, "synthetic-native-turn");
    expect(runtimeActivity(databaseFile)).toMatchObject({
      schemaVersion: 14,
      activeRuns: 3,
      queuedTasks: 0,
    });
    expect(() => assertRuntimeIdle(databaseFile)).toThrow("Refusing");
    expect(readFileSync(databaseFile)).toEqual(before);
  });

  it("keeps completed native output blocking activation until final delivery is recorded", () => {
    const { databaseFile, store } = setup();
    const current = claim(store, "synthetic-final");
    store.dispatch(current.eventId);
    store.complete(current.eventId, "Synthetic final result", "completed");
    expect(runtimeActivity(databaseFile)).toMatchObject({
      activeRuns: 0,
      queuedTasks: 0,
      delivering: 1,
      unresolvedExecutions: 0,
    });
    expect(() => assertRuntimeIdle(databaseFile)).toThrow("Refusing");
    store.delivered(current.eventId, "1.2");
    expect(assertRuntimeIdle(databaseFile)).toMatchObject({
      activeRuns: 0,
      queuedTasks: 0,
      delivering: 0,
      unresolvedExecutions: 0,
    });
  });

  it("retains the uncertainty fence after its notification is delivered", () => {
    const { databaseFile, store } = setup();
    const current = claim(store, "synthetic-uncertain");
    store.bind(current.conversationKey, "synthetic-native-thread", "/synthetic/workspace");
    store.dispatch(current.eventId);
    store.started(current.eventId, "synthetic-native-turn");
    store.failUncertainOnStartup();
    store.delivered(current.eventId, "1.2");
    const deliveryBefore = store.getDelivery(current.eventId);
    expect(runtimeActivity(databaseFile)).toMatchObject({
      activeRuns: 0,
      delivering: 0,
      unresolvedExecutions: 1,
    });
    expect(() => assertRuntimeIdle(databaseFile)).toThrow("unconfirmed executions");
    expect(store.getDelivery(current.eventId)).toEqual(deliveryBefore);
    expect(
      store.reconcileTerminal(
        current.conversationKey,
        "synthetic-native-thread",
        "synthetic-native-turn",
      ),
    ).toBe(true);
    expect(assertRuntimeIdle(databaseFile).unresolvedExecutions).toBe(0);
  });

  it("rejects an existing malformed native ledger without adding tables", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "native-release-malformed-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "bridge.sqlite");
    const nativeFile = path.join(directory, "native-conversations.sqlite");
    const database = new Database(nativeFile);
    database.exec("CREATE TABLE unrelated_table(value TEXT)");
    database.close();
    const before = readFileSync(nativeFile);
    expect(() => runtimeActivity(databaseFile)).toThrow(
      "Native transport activity could not be verified",
    );
    expect(readFileSync(nativeFile)).toEqual(before);
    expect(existsSync(databaseFile)).toBe(false);
  });

  it("does not create either database when neither is present", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "native-release-absent-"));
    directories.push(directory);
    const databaseFile = path.join(directory, "bridge.sqlite");
    expect(assertRuntimeIdle(databaseFile)).toMatchObject({
      schemaVersion: 0,
      activeRuns: 0,
      delivering: 0,
      queuedTasks: 0,
      unresolvedExecutions: 0,
    });
    expect(existsSync(databaseFile)).toBe(false);
    expect(existsSync(path.join(directory, "native-conversations.sqlite"))).toBe(false);
  });
});
