import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export const nativeConversationSchemaVersion = 1;

function schemaVersion(database: Database.Database): number {
  const version = database.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
    throw new Error("The native conversation schema version is invalid");
  return version;
}

export function readNativeConversationSchemaVersion(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return schemaVersion(database);
  } finally {
    database.close();
  }
}

export function hasNativeDelivery(
  file: string,
  identity: { eventId: string } | { channelId: string; messageTs: string },
): boolean {
  if (!existsSync(file)) return false;
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if ("eventId" in identity)
      return (
        database
          .prepare("SELECT 1 FROM native_deliveries WHERE event_id = ?")
          .get(identity.eventId) !== undefined
      );
    return (
      database
        .prepare("SELECT 1 FROM native_deliveries WHERE channel_id = ? AND message_ts = ?")
        .get(identity.channelId, identity.messageTs) !== undefined
    );
  } finally {
    database.close();
  }
}

export type NativeDeliveryState =
  | "queued"
  | "dispatching"
  | "running"
  | "completed"
  | "failed"
  | "uncertain"
  | "delivered";

export type NativeCompletionStatus = "completed" | "failed" | "uncertain";

export interface NativeClaim {
  eventId: string;
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  text: string;
}

export interface NativeDelivery extends NativeClaim {
  conversationKey: string;
  state: NativeDeliveryState;
  createdAt: string;
  updatedAt: string;
  nativeTurnId?: string;
  finalText?: string;
  completionStatus?: NativeCompletionStatus;
  rootEventId?: string;
  progressMessageTs?: string;
  deliveryMessageTs?: string;
  unadmittedTurnId?: string;
}

export interface NativeConversation {
  key: string;
  threadId?: string;
  cwd?: string;
  activeTurnId?: string;
  state: "idle" | "running" | "uncertain";
}

export interface NativeConversationRecord extends NativeConversation {
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
}

export interface NativeDeliveryPart {
  index: number;
  messageTs: string;
}

export interface NativeFinalIdentity {
  id: string;
  part: number;
  contentHash: string;
  attemptedAt: string;
}

export type NativeFinalReconciliation =
  | { status: "found"; messageTs: string }
  | { status: "absent" }
  | { status: "unknown"; reason?: string };

export interface NativeFinalPart {
  eventId: string;
  index: number;
  id: string;
  text: string;
  contentHash: string;
  state: "pending" | "sending" | "uncertain" | "confirmed";
  attemptedAt?: string;
  messageTs?: string;
  retryAfterAt?: string;
}

function partIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("The native delivery part index is invalid");
  return value;
}

function finalPart(value: unknown): NativeFinalPart {
  const row = record(value);
  const state = row.state;
  if (state !== "pending" && state !== "sending" && state !== "uncertain" && state !== "confirmed")
    throw new Error("The native final delivery state is invalid");
  const result: NativeFinalPart = {
    eventId: stringField(row, "event_id"),
    index: partIndex(row.part_index),
    id: stringField(row, "delivery_id"),
    text: stringField(row, "text"),
    contentHash: stringField(row, "content_hash"),
    state,
  };
  const attemptedAt = optionalString(row, "attempted_at");
  const messageTs = optionalString(row, "message_ts");
  if (attemptedAt !== undefined) result.attemptedAt = attemptedAt;
  if (messageTs !== undefined) result.messageTs = messageTs;
  const retryAfterAt = optionalString(row, "retry_after_at");
  if (retryAfterAt !== undefined) result.retryAfterAt = retryAfterAt;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("The native transport row is invalid");
  }
  return value;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`The native transport ${key} is invalid`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return stringField(row, key);
}

function deliveryState(value: unknown): NativeDeliveryState {
  switch (value) {
    case "queued":
    case "dispatching":
    case "running":
    case "completed":
    case "failed":
    case "uncertain":
    case "delivered":
      return value;
    default:
      throw new Error("The native delivery state is invalid");
  }
}

function completionStatus(value: unknown): NativeCompletionStatus {
  if (value === "completed" || value === "failed" || value === "uncertain") return value;
  throw new Error("The native completion status is invalid");
}

function inputString(value: unknown, name: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > 1_000_000 ||
    (!allowEmpty && value.trim().length === 0)
  )
    throw new Error(`The native transport ${name} is invalid`);
  return value;
}

function delivery(value: unknown): NativeDelivery {
  const row = record(value);
  const result: NativeDelivery = {
    eventId: stringField(row, "event_id"),
    teamId: stringField(row, "team_id"),
    userId: stringField(row, "user_id"),
    channelId: stringField(row, "channel_id"),
    threadTs: stringField(row, "thread_ts"),
    messageTs: stringField(row, "message_ts"),
    text: stringField(row, "text"),
    conversationKey: stringField(row, "conversation_key"),
    state: deliveryState(row.state),
    createdAt: stringField(row, "created_at"),
    updatedAt: stringField(row, "updated_at"),
  };
  const fields = {
    nativeTurnId: optionalString(row, "native_turn_id"),
    finalText: optionalString(row, "final_text"),
    progressMessageTs: optionalString(row, "progress_message_ts"),
    deliveryMessageTs: optionalString(row, "delivery_message_ts"),
    rootEventId: optionalString(row, "root_event_id"),
  };
  if (fields.nativeTurnId !== undefined) result.nativeTurnId = fields.nativeTurnId;
  if (fields.finalText !== undefined) result.finalText = fields.finalText;
  if (fields.progressMessageTs !== undefined) result.progressMessageTs = fields.progressMessageTs;
  if (fields.deliveryMessageTs !== undefined) result.deliveryMessageTs = fields.deliveryMessageTs;
  if (fields.rootEventId !== undefined) result.rootEventId = fields.rootEventId;
  if (row.completion_status !== null)
    result.completionStatus = completionStatus(row.completion_status);
  return result;
}

export class NativeConversationStore {
  readonly #database: Database.Database;

  constructor(file: string) {
    inputString(file, "database path");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.#database = new Database(file);
    try {
      if (schemaVersion(this.#database) > nativeConversationSchemaVersion)
        throw new Error("The native conversation schema is newer than this release supports");
    } catch (error) {
      this.#database.close();
      throw error;
    }
    const tables = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    if (
      tables.some((row) => {
        const name = stringField(record(row), "name");
        return (
          name !== "native_conversations" &&
          name !== "native_deliveries" &&
          name !== "native_delivery_parts" &&
          name !== "native_final_delivery_intents" &&
          name !== "native_unadmitted_steers" &&
          name !== "native_followups"
        );
      })
    ) {
      this.#database.close();
      throw new Error("The native transport requires its own database file");
    }
    chmodSync(file, 0o600);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = FULL");
    try {
      this.#database
        .transaction(() => {
          this.#database.exec(`
      CREATE TABLE IF NOT EXISTS native_conversations (
        key TEXT PRIMARY KEY, thread_id TEXT, cwd TEXT, active_turn_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('idle','running','uncertain')), active_event_id TEXT
      );
      CREATE TABLE IF NOT EXISTS native_deliveries (
        event_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES native_conversations(key),
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL, message_ts TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','dispatching','running','completed','failed','uncertain','delivered')),
        native_turn_id TEXT, final_text TEXT, completion_status TEXT,
        progress_message_ts TEXT, delivery_message_ts TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(team_id,channel_id,message_ts)
      );
      CREATE INDEX IF NOT EXISTS native_delivery_conversation ON native_deliveries(conversation_key);
      CREATE UNIQUE INDEX IF NOT EXISTS native_bound_thread ON native_conversations(thread_id) WHERE thread_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS native_delivery_parts (
        event_id TEXT NOT NULL REFERENCES native_deliveries(event_id),
        part_index INTEGER NOT NULL CHECK(part_index>=0), message_ts TEXT NOT NULL,
        PRIMARY KEY(event_id,part_index), UNIQUE(event_id,message_ts)
      );
      CREATE TABLE IF NOT EXISTS native_followups (
        event_id TEXT PRIMARY KEY REFERENCES native_deliveries(event_id),
        root_event_id TEXT NOT NULL REFERENCES native_deliveries(event_id), CHECK(event_id!=root_event_id)
      );
      CREATE TABLE IF NOT EXISTS native_final_delivery_intents (
        event_id TEXT NOT NULL REFERENCES native_deliveries(event_id),
        part_index INTEGER NOT NULL CHECK(part_index>=0), delivery_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL, content_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','uncertain','confirmed')),
        attempted_at TEXT, message_ts TEXT, retry_after_at TEXT,
        PRIMARY KEY(event_id,part_index),
        CHECK(state!='confirmed' OR message_ts IS NOT NULL),
        CHECK(state NOT IN ('sending','uncertain') OR attempted_at IS NOT NULL)
      );
      CREATE TABLE IF NOT EXISTS native_unadmitted_steers (
        event_id TEXT PRIMARY KEY REFERENCES native_deliveries(event_id), expected_turn_id TEXT NOT NULL
      );
        `);
          this.#database.pragma(`user_version = ${nativeConversationSchemaVersion}`);
        })
        .immediate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  claim(input: NativeClaim): NativeDelivery | undefined {
    for (const [name, value] of Object.entries({
      eventId: input.eventId,
      teamId: input.teamId,
      userId: input.userId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      messageTs: input.messageTs,
      text: input.text,
    }))
      inputString(value, name, name === "text");
    const key = JSON.stringify([input.teamId, input.userId, input.channelId, input.threadTs]);
    return this.#database
      .transaction(() => {
        const existing = this.#database
          .prepare(
            "SELECT event_id FROM native_deliveries WHERE event_id=? OR (team_id=? AND channel_id=? AND message_ts=?) LIMIT 1",
          )
          .get(input.eventId, input.teamId, input.channelId, input.messageTs);
        if (existing !== undefined) return undefined;
        this.#database
          .prepare("INSERT OR IGNORE INTO native_conversations(key,state) VALUES(?,'idle')")
          .run(key);
        const now = new Date().toISOString();
        this.#database
          .prepare(`INSERT INTO native_deliveries
        (event_id,conversation_key,team_id,user_id,channel_id,thread_ts,message_ts,text,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`)
          .run(
            input.eventId,
            key,
            input.teamId,
            input.userId,
            input.channelId,
            input.threadTs,
            input.messageTs,
            input.text,
            now,
            now,
          );
        return this.getDelivery(input.eventId);
      })
      .immediate();
  }

  getConversation(key: string): NativeConversation | undefined {
    const value = this.#database.prepare("SELECT * FROM native_conversations WHERE key=?").get(key);
    if (value === undefined) return undefined;
    const row = record(value);
    const state = row.state;
    if (state !== "idle" && state !== "running" && state !== "uncertain")
      throw new Error("The native conversation state is invalid");
    const result: NativeConversation = { key: stringField(row, "key"), state };
    const threadId = optionalString(row, "thread_id");
    const cwd = optionalString(row, "cwd");
    const activeTurnId = optionalString(row, "active_turn_id");
    if (threadId !== undefined) result.threadId = threadId;
    if (cwd !== undefined) result.cwd = cwd;
    if (activeTurnId !== undefined) result.activeTurnId = activeTurnId;
    return result;
  }

  listConversations(): NativeConversationRecord[] {
    return this.#database
      .prepare(`SELECT conversation.key,delivery.team_id,delivery.user_id,delivery.channel_id,delivery.thread_ts
        FROM native_conversations conversation JOIN native_deliveries delivery ON delivery.rowid=(
          SELECT MAX(candidate.rowid) FROM native_deliveries candidate WHERE candidate.conversation_key=conversation.key
        ) ORDER BY delivery.rowid`)
      .all()
      .map((value) => {
        const row = record(value);
        const conversation = this.getConversation(stringField(row, "key"));
        if (conversation === undefined) throw new Error("The native conversation disappeared");
        return {
          ...conversation,
          teamId: stringField(row, "team_id"),
          userId: stringField(row, "user_id"),
          channelId: stringField(row, "channel_id"),
          threadTs: stringField(row, "thread_ts"),
        };
      });
  }

  listDeliveriesForConversation(key: string): NativeDelivery[] {
    return this.#database
      .prepare("SELECT event_id FROM native_deliveries WHERE conversation_key=? ORDER BY rowid")
      .all(key)
      .map((value) => this.#required(stringField(record(value), "event_id")));
  }

  bind(key: string, threadId: string, cwd: string): void {
    inputString(threadId, "native thread");
    inputString(cwd, "working directory");
    const result = this.#database
      .prepare(`UPDATE native_conversations SET thread_id=?,cwd=?
      WHERE key=? AND state!='uncertain' AND (thread_id IS NULL OR thread_id=?) AND (cwd IS NULL OR cwd=?)`)
      .run(threadId, cwd, key, threadId, cwd);
    if (result.changes !== 1)
      throw new Error("The native conversation binding is unavailable or changed");
  }

  dispatch(eventId: string): void {
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        const conversation = this.getConversation(current.conversationKey);
        if (current.state !== "queued" || conversation?.state !== "idle")
          throw new Error("The native conversation cannot dispatch this event");
        this.#database
          .prepare("UPDATE native_deliveries SET state='dispatching',updated_at=? WHERE event_id=?")
          .run(new Date().toISOString(), eventId);
        this.#database
          .prepare(
            "UPDATE native_conversations SET state='running',active_event_id=?,active_turn_id=NULL WHERE key=?",
          )
          .run(eventId, current.conversationKey);
        this.#database
          .prepare("DELETE FROM native_unadmitted_steers WHERE event_id=?")
          .run(eventId);
      })
      .immediate();
  }

  started(eventId: string, turnId: string): void {
    inputString(turnId, "native turn");
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        if (current.state === "running" && current.nativeTurnId === turnId) return;
        if (current.state !== "dispatching")
          throw new Error("The native event was not awaiting dispatch");
        this.#database
          .prepare(
            "UPDATE native_deliveries SET state='running',native_turn_id=?,updated_at=? WHERE event_id=?",
          )
          .run(turnId, new Date().toISOString(), eventId);
        const changed = this.#database
          .prepare(
            "UPDATE native_conversations SET active_turn_id=? WHERE key=? AND active_event_id=? AND state='running'",
          )
          .run(turnId, current.conversationKey, eventId);
        if (changed.changes !== 1) throw new Error("The native active event changed");
      })
      .immediate();
  }

  steering(eventId: string, turnId: string): void {
    inputString(turnId, "native steering turn");
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        const conversation = this.getConversation(current.conversationKey);
        if (
          current.state !== "queued" ||
          conversation?.state !== "running" ||
          conversation.activeTurnId !== turnId ||
          conversation.threadId === undefined
        )
          throw new Error("The native steering turn does not match this conversation");
        this.#database
          .prepare(
            "UPDATE native_deliveries SET state='dispatching',native_turn_id=?,updated_at=? WHERE event_id=?",
          )
          .run(turnId, new Date().toISOString(), eventId);
      })
      .immediate();
  }

  steered(eventId: string, turnId: string): void {
    inputString(turnId, "native steering turn");
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        if (current.state === "running" && current.nativeTurnId === turnId) return;
        const conversation = this.getConversation(current.conversationKey);
        if (
          current.state !== "dispatching" ||
          current.nativeTurnId !== turnId ||
          conversation?.state !== "running" ||
          conversation.activeTurnId !== turnId
        )
          throw new Error("The native steering receipt no longer matches the active turn");
        this.#database
          .prepare("UPDATE native_deliveries SET state='running',updated_at=? WHERE event_id=?")
          .run(new Date().toISOString(), eventId);
      })
      .immediate();
  }

  markUnadmitted(eventId: string, expectedTurnId: string): void {
    inputString(expectedTurnId, "unadmitted turn");
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        if (current.unadmittedTurnId === expectedTurnId) return;
        if (
          current.state !== "dispatching" ||
          current.nativeTurnId !== expectedTurnId ||
          current.rootEventId !== undefined ||
          current.completionStatus !== undefined
        )
          throw new Error("Only a proven unadmitted steering dispatch can be retained");
        this.#database
          .prepare("INSERT INTO native_unadmitted_steers(event_id,expected_turn_id) VALUES(?,?)")
          .run(eventId, expectedTurnId);
      })
      .immediate();
  }

  listUnadmitted(): NativeDelivery[] {
    return this.#database
      .prepare(`SELECT delivery.event_id FROM native_deliveries delivery
      JOIN native_unadmitted_steers retained ON retained.event_id=delivery.event_id
      WHERE delivery.completion_status IS NULL ORDER BY delivery.rowid`)
      .all()
      .map((value) => this.#required(stringField(record(value), "event_id")));
  }

  retryUnadmitted(eventId: string, expectedTurnId: string): void {
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        const conversation = this.getConversation(current.conversationKey);
        const terminal = this.#database
          .prepare(`SELECT event_id FROM native_deliveries
        WHERE conversation_key=? AND native_turn_id=? AND completion_status IN ('completed','failed','uncertain')
        AND event_id NOT IN (SELECT event_id FROM native_followups) LIMIT 1`)
          .get(current.conversationKey, expectedTurnId);
        if (
          current.unadmittedTurnId !== expectedTurnId ||
          conversation?.state !== "idle" ||
          terminal === undefined ||
          current.completionStatus !== undefined ||
          current.rootEventId !== undefined ||
          (current.state !== "dispatching" && current.state !== "queued")
        )
          throw new Error(
            "The proven unadmitted instruction cannot resume before its original turn terminates",
          );
        this.#database
          .prepare(
            "UPDATE native_deliveries SET state='queued',native_turn_id=NULL,updated_at=? WHERE event_id=?",
          )
          .run(new Date().toISOString(), eventId);
      })
      .immediate();
  }

  reconcileTerminal(key: string, threadId: string, turnId: string): boolean {
    inputString(threadId, "native terminal thread");
    inputString(turnId, "native terminal turn");
    const result = this.#database
      .prepare(`UPDATE native_conversations
      SET state='idle',active_event_id=NULL,active_turn_id=NULL
      WHERE key=? AND thread_id=? AND active_turn_id=? AND state='uncertain'`)
      .run(key, threadId, turnId);
    return result.changes === 1;
  }

  linkFollowup(eventId: string, rootEventId: string): void {
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        const root = this.#required(rootEventId);
        if (current.rootEventId === rootEventId) return;
        if (
          eventId === rootEventId ||
          current.rootEventId !== undefined ||
          root.rootEventId !== undefined ||
          current.conversationKey !== root.conversationKey ||
          current.nativeTurnId === undefined ||
          current.nativeTurnId !== root.nativeTurnId ||
          (current.state !== "dispatching" && current.state !== "running")
        )
          throw new Error("The accepted steering follow-up does not match its primary native turn");
        if (
          this.#database
            .prepare("SELECT event_id FROM native_followups WHERE root_event_id=? LIMIT 1")
            .get(eventId) !== undefined
        )
          throw new Error("Native steering delivery links cannot form chains");
        this.#database
          .prepare("INSERT INTO native_followups(event_id,root_event_id) VALUES(?,?)")
          .run(eventId, rootEventId);
        if (current.state === "dispatching")
          this.#database
            .prepare("UPDATE native_deliveries SET state='running',updated_at=? WHERE event_id=?")
            .run(new Date().toISOString(), eventId);
        if (root.completionStatus !== undefined && root.finalText !== undefined) {
          this.complete(eventId, root.finalText, root.completionStatus);
          if (root.deliveryMessageTs !== undefined) this.delivered(eventId, root.deliveryMessageTs);
        }
      })
      .immediate();
  }

  complete(eventId: string, text: string, status: NativeCompletionStatus): void {
    inputString(text, "final text", true);
    completionStatus(status);
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        if (current.completionStatus === status && current.finalText === text) return;
        if (
          current.completionStatus !== undefined ||
          (current.state === "queued" && status !== "failed")
        )
          throw new Error("The native final result cannot be replaced");
        this.#database
          .prepare(
            "UPDATE native_deliveries SET state=?,final_text=?,completion_status=?,updated_at=? WHERE event_id=?",
          )
          .run(status, text, status, new Date().toISOString(), eventId);
        this.#database
          .prepare("DELETE FROM native_unadmitted_steers WHERE event_id=?")
          .run(eventId);
        if (status === "uncertain") {
          this.#database
            .prepare(
              "UPDATE native_conversations SET state='uncertain' WHERE key=? AND active_event_id=?",
            )
            .run(current.conversationKey, eventId);
        } else {
          this.#database
            .prepare(
              "UPDATE native_conversations SET state='idle',active_event_id=NULL,active_turn_id=NULL WHERE key=? AND active_event_id=?",
            )
            .run(current.conversationKey, eventId);
        }
        for (const follower of this.#linkedFollowers(eventId)) {
          if (follower.state === "running") this.complete(follower.eventId, text, status);
        }
      })
      .immediate();
  }

  pendingDeliveries(): NativeDelivery[] {
    return this.#database
      .prepare(
        "SELECT delivery.* FROM native_deliveries delivery LEFT JOIN native_followups followup ON followup.event_id=delivery.event_id WHERE delivery.final_text IS NOT NULL AND delivery.delivery_message_ts IS NULL AND followup.root_event_id IS NULL ORDER BY delivery.rowid",
      )
      .all()
      .map(delivery);
  }

  delivered(eventId: string, messageTs: string): void {
    inputString(messageTs, "Slack delivery receipt");
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        const intents = this.getFinalParts(eventId);
        if (
          intents.length > 0 &&
          (intents.some((part) => part.state !== "confirmed") ||
            intents.at(-1)?.messageTs !== messageTs)
        )
          throw new Error("The native final parts are not all confirmed");
        const result = this.#database
          .prepare(`UPDATE native_deliveries SET state='delivered',delivery_message_ts=?,updated_at=?
      WHERE event_id=? AND final_text IS NOT NULL AND (delivery_message_ts IS NULL OR delivery_message_ts=?)`)
          .run(messageTs, new Date().toISOString(), eventId, messageTs);
        if (result.changes !== 1)
          throw new Error("The native delivery has no final result or its receipt changed");
        for (const follower of this.#linkedFollowers(eventId)) {
          if (follower.finalText !== undefined) {
            if (
              follower.finalText !== current.finalText ||
              follower.completionStatus !== current.completionStatus
            )
              throw new Error(
                "The linked follow-up final result differs from its primary delivery",
              );
            this.delivered(follower.eventId, messageTs);
          }
        }
      })
      .immediate();
  }

  prepareFinalParts(
    eventId: string,
    texts: readonly string[],
    transform: (text: string) => string = (text) => text,
  ): NativeFinalPart[] {
    return this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        if (current.finalText === undefined || current.rootEventId !== undefined)
          throw new Error("Only a primary persisted native final can prepare delivery");
        let expected = transform(current.finalText);
        if (expected.length === 0) expected = "Codex completed without a final response.";
        if (
          texts.length === 0 ||
          texts.some((text) => text.length === 0) ||
          texts.join("") !== expected
        )
          throw new Error("The native final delivery parts do not match the persisted result");
        const existing = this.getFinalParts(eventId);
        if (existing.length > 0) {
          if (
            existing.length !== texts.length ||
            existing.some((part, index) => part.text !== texts[index])
          )
            throw new Error("The native final delivery content cannot change");
          return existing;
        }
        const receipts = this.getDeliveryParts(eventId);
        if (receipts.some((part) => part.index >= texts.length))
          throw new Error("Existing native delivery receipts do not match the final result");
        const insert = this.#database.prepare(`INSERT INTO native_final_delivery_intents
        (event_id,part_index,delivery_id,text,content_hash,state,message_ts) VALUES(?,?,?,?,?,?,?)`);
        for (const [index, text] of texts.entries()) {
          inputString(text, "final delivery part");
          const known = receipts.find((part) => part.index === index);
          let receipt = known?.messageTs;
          let state = "pending";
          if (known !== undefined) state = "confirmed";
          if (index === 0 && receipt === undefined) receipt = current.progressMessageTs;
          insert.run(
            eventId,
            index,
            randomUUID(),
            text,
            createHash("sha256").update(text).digest("hex"),
            state,
            receipt ?? null,
          );
        }
        return this.getFinalParts(eventId);
      })
      .immediate();
  }

  getFinalParts(eventId: string): NativeFinalPart[] {
    return this.#database
      .prepare("SELECT * FROM native_final_delivery_intents WHERE event_id=? ORDER BY part_index")
      .all(eventId)
      .map(finalPart);
  }

  beginFinalPart(eventId: string, index: number): NativeFinalPart {
    partIndex(index);
    const result = this.#database
      .prepare(`UPDATE native_final_delivery_intents
      SET state='sending',attempted_at=COALESCE(attempted_at,?)
      WHERE event_id=? AND part_index=? AND state='pending' AND (retry_after_at IS NULL OR retry_after_at<=?)`)
      .run(new Date().toISOString(), eventId, index, new Date().toISOString());
    if (result.changes !== 1) throw new Error("The native final part is not pending delivery");
    return this.#requiredFinalPart(eventId, index);
  }

  uncertainFinalPart(eventId: string, index: number): void {
    const current = this.#requiredFinalPart(eventId, index);
    if (current.state === "uncertain" || current.state === "confirmed") return;
    const result = this.#database
      .prepare(
        "UPDATE native_final_delivery_intents SET state='uncertain' WHERE event_id=? AND part_index=? AND state='sending'",
      )
      .run(eventId, index);
    if (result.changes !== 1)
      throw new Error("The native final part was not awaiting a send receipt");
  }

  retryFinalPart(eventId: string, index: number, retryAfterMs = 0): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 86_400_000)
      throw new Error("The native final retry delay is invalid");
    const result = this.#database
      .prepare(
        "UPDATE native_final_delivery_intents SET state='pending',retry_after_at=? WHERE event_id=? AND part_index=? AND state IN ('sending','uncertain')",
      )
      .run(new Date(Date.now() + retryAfterMs).toISOString(), eventId, partIndex(index));
    if (result.changes !== 1)
      throw new Error("The native final part cannot return to pending delivery");
  }

  confirmFinalPart(eventId: string, index: number, messageTs: string): void {
    inputString(messageTs, "final receipt");
    this.#database
      .transaction(() => {
        const current = this.#requiredFinalPart(eventId, index);
        if (current.messageTs !== undefined && current.messageTs !== messageTs)
          throw new Error("The native final receipt changed");
        if (current.state === "pending" && current.messageTs === undefined)
          throw new Error("The native final part has no attempted send");
        this.deliveredPart(eventId, index, messageTs);
        this.#database
          .prepare(
            "UPDATE native_final_delivery_intents SET state='confirmed',message_ts=? WHERE event_id=? AND part_index=?",
          )
          .run(messageTs, eventId, index);
      })
      .immediate();
  }

  getDeliveryParts(eventId: string): NativeDeliveryPart[] {
    return this.#database
      .prepare(
        "SELECT part_index,message_ts FROM native_delivery_parts WHERE event_id=? ORDER BY part_index",
      )
      .all(eventId)
      .map((value) => {
        const row = record(value);
        const index = row.part_index;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
          throw new Error("The native delivery part index is invalid");
        return { index, messageTs: stringField(row, "message_ts") };
      });
  }

  deliveredPart(eventId: string, index: number, messageTs: string): void {
    if (!Number.isSafeInteger(index) || index < 0)
      throw new Error("The native delivery part index is invalid");
    inputString(messageTs, "Slack delivery part receipt");
    this.#database
      .transaction(() => {
        const current = this.#required(eventId);
        if (current.finalText === undefined)
          throw new Error("The native delivery part has no persisted final result");
        const existing = this.#database
          .prepare("SELECT message_ts FROM native_delivery_parts WHERE event_id=? AND part_index=?")
          .get(eventId, index);
        if (existing !== undefined) {
          if (stringField(record(existing), "message_ts") !== messageTs)
            throw new Error("The native delivery part receipt changed");
          return;
        }
        if (current.deliveryMessageTs !== undefined)
          throw new Error("The completed native delivery cannot gain new parts");
        this.#database
          .prepare(
            "INSERT INTO native_delivery_parts(event_id,part_index,message_ts) VALUES(?,?,?)",
          )
          .run(eventId, index, messageTs);
      })
      .immediate();
  }

  getDelivery(eventId: string): NativeDelivery | undefined {
    const row = this.#database
      .prepare(
        "SELECT delivery.*,followup.root_event_id FROM native_deliveries delivery LEFT JOIN native_followups followup ON followup.event_id=delivery.event_id WHERE delivery.event_id=?",
      )
      .get(eventId);
    if (row === undefined) return undefined;
    const current = delivery(row);
    const retained = this.#database
      .prepare("SELECT expected_turn_id FROM native_unadmitted_steers WHERE event_id=?")
      .get(eventId);
    if (retained !== undefined)
      current.unadmittedTurnId = stringField(record(retained), "expected_turn_id");
    return current;
  }

  lastForConversation(key: string): NativeDelivery | undefined {
    const row = this.#database
      .prepare(
        "SELECT delivery.*,followup.root_event_id FROM native_deliveries delivery LEFT JOIN native_followups followup ON followup.event_id=delivery.event_id WHERE delivery.conversation_key=? ORDER BY delivery.rowid DESC LIMIT 1",
      )
      .get(key);
    return row === undefined ? undefined : delivery(row);
  }

  setProgressReceipt(eventId: string, receipt: string): void {
    inputString(receipt, "Slack progress receipt");
    const result = this.#database
      .prepare(`UPDATE native_deliveries SET progress_message_ts=?,updated_at=?
      WHERE event_id=? AND (progress_message_ts IS NULL OR progress_message_ts=?)`)
      .run(receipt, new Date().toISOString(), eventId, receipt);
    if (result.changes !== 1)
      throw new Error("The native progress receipt is unavailable or changed");
  }

  failUncertainOnStartup(): NativeDelivery[] {
    return this.#database
      .transaction(() => {
        this.#database
          .prepare(
            "UPDATE native_final_delivery_intents SET state='uncertain' WHERE state='sending'",
          )
          .run();
        const interrupted = this.#database
          .prepare(
            "SELECT * FROM native_deliveries WHERE state IN ('queued','dispatching','running') AND event_id NOT IN (SELECT event_id FROM native_unadmitted_steers) ORDER BY rowid",
          )
          .all()
          .map(delivery);
        for (const current of interrupted) {
          if (current.state === "queued") {
            this.complete(
              current.eventId,
              "This request was interrupted before native dispatch. Send it again to start it.",
              "failed",
            );
          } else {
            this.complete(
              current.eventId,
              "The bridge restarted after native dispatch. The previous turn may still be running; it has not been replayed. Check its Codex session before continuing this conversation.",
              "uncertain",
            );
          }
        }
        return interrupted.map((current) => this.#required(current.eventId));
      })
      .immediate();
  }

  #required(eventId: string): NativeDelivery {
    const result = this.getDelivery(eventId);
    if (result === undefined) throw new Error("The native transport event is unavailable");
    return result;
  }

  #requiredFinalPart(eventId: string, index: number): NativeFinalPart {
    const row = this.#database
      .prepare("SELECT * FROM native_final_delivery_intents WHERE event_id=? AND part_index=?")
      .get(eventId, partIndex(index));
    if (row === undefined) throw new Error("The native final part is unavailable");
    return finalPart(row);
  }

  #linkedFollowers(eventId: string): NativeDelivery[] {
    return this.#database
      .prepare(
        "SELECT delivery.*,followup.root_event_id FROM native_deliveries delivery JOIN native_followups followup ON followup.event_id=delivery.event_id WHERE followup.root_event_id=? ORDER BY delivery.rowid",
      )
      .all(eventId)
      .map(delivery);
  }
}
