import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { legacyMigrations } from "../src/persistence/legacy-schema.js";
import { SqliteStore } from "../src/persistence/sqlite.js";

const directories: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function databaseFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "runtime-store-"));
  directories.push(directory);
  return path.join(directory, "private-store", "bridge.sqlite");
}

function historicalDatabase(file: string, throughVersion: number): Database.Database {
  const database = new Database(file);
  database.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const migration of legacyMigrations) {
    if (migration.version > throughVersion) continue;
    database.exec(migration.sql);
    database
      .prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)")
      .run(migration.version, timestamp);
  }
  return database;
}

describe("minimal runtime ownership persistence", () => {
  it("creates the exact historical schema required by prior releases with private file permissions", () => {
    const file = databaseFile();
    SqliteStore.open(file).close();
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const database = new Database(file, { readonly: true });
    try {
      expect(
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual(Array.from({ length: 14 }, (_, index) => ({ version: index + 1 })));
      const schema = database
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE ? ORDER BY type,name",
        )
        .all("sqlite_%");
      expect(createHash("sha256").update(JSON.stringify(schema)).digest("hex")).toBe(
        "e394f3e81d3b01c7f4558b3cca4356f0dab2cd9e715508ef5f8c406f6ef3c93f",
      );
    } finally {
      database.close();
    }
  });

  it("supports independent in-memory ownership stores", () => {
    const first = SqliteStore.open(":memory:");
    const second = SqliteStore.open(":memory:");
    const owner = {
      ownerId: "synthetic-owner",
      pid: process.pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
    };
    try {
      expect(first.claimRuntimeOwner(owner)).toBe(true);
      expect(first.getRuntimeOwner()).toEqual(owner);
      expect(second.getRuntimeOwner()).toBeUndefined();
      expect(first.releaseRuntimeOwner(owner)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it("upgrades a version thirteen database while preserving legacy work and its owner record", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "historical-runtime-store-"));
    directories.push(directory);
    const file = path.join(directory, "bridge.sqlite");
    const historical = historicalDatabase(file, 13);
    const payload = JSON.stringify({
      syntheticCredentialReference: "keep-existing-auth-reference",
      phase: "cancellation-unconfirmed",
    });
    historical
      .prepare(
        "INSERT INTO tasks(task_id,conversation_key,state,revision,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run("synthetic-task", "synthetic-conversation", "blocked", 1, timestamp, timestamp, payload);
    historical
      .prepare(
        "INSERT INTO active_runs(event_id,channel_id,slack_thread_ts,started_at) VALUES(?,?,?,?)",
      )
      .run("synthetic-event", "synthetic-channel", "1.0", timestamp);
    historical
      .prepare(
        "INSERT INTO runtime_owner(slot,owner_id,pid,acquired_at,heartbeat_at) VALUES(1,?,?,?,?)",
      )
      .run("preserved-owner", 123456, timestamp, timestamp);
    const before = {
      task: historical.prepare("SELECT * FROM tasks").all(),
      run: historical.prepare("SELECT * FROM active_runs").all(),
      migrations: historical.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
    };
    historical.close();
    const store = SqliteStore.open(file);
    try {
      expect(store.getRuntimeOwner()).toEqual({
        ownerId: "preserved-owner",
        pid: 123456,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
      });
    } finally {
      store.close();
    }
    const reopened = new Database(file, { readonly: true });
    try {
      expect(reopened.prepare("SELECT * FROM tasks").all()).toEqual(before.task);
      expect(reopened.prepare("SELECT * FROM active_runs").all()).toEqual(before.run);
      expect(
        reopened
          .prepare("SELECT * FROM schema_migrations WHERE version<=13 ORDER BY version")
          .all(),
      ).toEqual(before.migrations);
      expect(
        reopened.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({ version: 14 });
      expect(
        reopened.prepare("SELECT name FROM sqlite_master WHERE name='bot_native_threads'").get(),
      ).toEqual({ name: "bot_native_threads" });
    } finally {
      reopened.close();
    }
    SqliteStore.open(file).close();
  });

  it("refuses a newer database schema without replacing historical data or migration records", () => {
    const file = databaseFile();
    SqliteStore.open(file).close();
    const database = new Database(file);
    database
      .prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(15,?)")
      .run(timestamp);
    database
      .prepare("INSERT INTO processed_events(event_id,processed_at) VALUES(?,?)")
      .run("preserved-event", timestamp);
    const versions = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    database.close();
    expect(() => SqliteStore.open(file)).toThrow("newer than this release supports");
    const reopened = new Database(file, { readonly: true });
    try {
      expect(reopened.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
        versions,
      );
      expect(reopened.prepare("SELECT * FROM processed_events").all()).toEqual([
        { event_id: "preserved-event", processed_at: timestamp },
      ]);
    } finally {
      reopened.close();
    }
  });
});
