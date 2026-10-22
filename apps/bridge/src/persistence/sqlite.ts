import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { type } from "arktype";
import Database from "better-sqlite3";

import { parseArk } from "../validation/parse.js";
import { legacyMigrations } from "./legacy-schema.js";

export interface RuntimeOwnerRecord {
  acquiredAt: string;
  heartbeatAt: string;
  ownerId: string;
  pid: number;
}

const runtimeOwnerRowType = type({
  acquired_at: "string",
  heartbeat_at: "string",
  owner_id: "string",
  pid: "number.integer > 0",
});

export class SqliteStore {
  readonly #database: Database.Database;

  private constructor(database: Database.Database) {
    this.#database = database;
  }

  static open(filePath: string): SqliteStore {
    if (filePath !== ":memory:") {
      const directory = path.dirname(filePath);
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700, recursive: true });
    }
    const database = new Database(filePath);
    try {
      if (filePath !== ":memory:") chmodSync(filePath, 0o600);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      database.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const migrationRowType = type({ version: "number.integer" });
      const appliedRows = database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => parseArk(migrationRowType, row, "migration row").version);
      const supportedVersion = Math.max(...legacyMigrations.map((migration) => migration.version));
      if (appliedRows.some((version) => version > supportedVersion))
        throw new Error("The preserved database schema is newer than this release supports");
      const applied = new Set(appliedRows);
      for (const migration of legacyMigrations) {
        if (applied.has(migration.version)) continue;
        database.transaction(() => {
          database.exec(migration.sql);
          database
            .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
        })();
      }
      return new SqliteStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  getRuntimeOwner(): RuntimeOwnerRecord | undefined {
    const row = this.#database
      .prepare("SELECT owner_id, pid, acquired_at, heartbeat_at FROM runtime_owner WHERE slot = 1")
      .get();
    if (row === undefined) {
      return undefined;
    }
    const parsed = parseArk(runtimeOwnerRowType, row, "runtime owner row");
    return {
      acquiredAt: parsed.acquired_at,
      heartbeatAt: parsed.heartbeat_at,
      ownerId: parsed.owner_id,
      pid: parsed.pid,
    };
  }

  claimRuntimeOwner(
    replacement: RuntimeOwnerRecord,
    expected?: Pick<RuntimeOwnerRecord, "ownerId" | "pid">,
  ): boolean {
    return this.#database
      .transaction(() => {
        if (expected === undefined) {
          return (
            this.#database
              .prepare(
                `INSERT OR IGNORE INTO runtime_owner (slot, owner_id, pid, acquired_at, heartbeat_at)
               VALUES (1, ?, ?, ?, ?)`,
              )
              .run(
                replacement.ownerId,
                replacement.pid,
                replacement.acquiredAt,
                replacement.heartbeatAt,
              ).changes === 1
          );
        }
        return (
          this.#database
            .prepare(
              `UPDATE runtime_owner SET owner_id = ?, pid = ?, acquired_at = ?, heartbeat_at = ?
             WHERE slot = 1 AND owner_id = ? AND pid = ?`,
            )
            .run(
              replacement.ownerId,
              replacement.pid,
              replacement.acquiredAt,
              replacement.heartbeatAt,
              expected.ownerId,
              expected.pid,
            ).changes === 1
        );
      })
      .immediate();
  }

  heartbeatRuntimeOwner(
    owner: Pick<RuntimeOwnerRecord, "ownerId" | "pid">,
    heartbeatAt: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          "UPDATE runtime_owner SET heartbeat_at = ? WHERE slot = 1 AND owner_id = ? AND pid = ?",
        )
        .run(heartbeatAt, owner.ownerId, owner.pid).changes === 1
    );
  }

  releaseRuntimeOwner(owner: Pick<RuntimeOwnerRecord, "ownerId" | "pid">): boolean {
    return (
      this.#database
        .prepare("DELETE FROM runtime_owner WHERE slot = 1 AND owner_id = ? AND pid = ?")
        .run(owner.ownerId, owner.pid).changes === 1
    );
  }
}
