import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NativeConversationStore } from "../persistence/native-conversation-store.js";
import { SqliteStore } from "../persistence/sqlite.js";
import { acquireRuntimeOwner, probeRuntimeProcess } from "../runtime/runtime-owner.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStopped(home: string): void {
  const healthFile = path.join(home, "runtime-health.json");
  if (!existsSync(healthFile)) return;
  const health: unknown = JSON.parse(readFileSync(healthFile, "utf8"));
  if (
    !record(health) ||
    typeof health.pid !== "number" ||
    !Number.isSafeInteger(health.pid) ||
    health.pid < 1
  )
    throw new Error(
      "Runtime health does not identify a process; inspect the local runtime before recovery",
    );
  if (probeRuntimeProcess(health.pid) !== "dead")
    throw new Error("Stop the Slack bridge runtime before recovering a Claude session");
}

export function recoverClaudeSession(input: {
  home: string;
  provider: "claude" | "codex";
  sessionId: string;
  confirmedStopped: boolean;
}): { sessionId: string; turnId: string; recoveryRecord: string } {
  if (input.provider !== "claude")
    throw new Error("Select the Claude provider before recovering its session");
  if (!input.confirmedStopped)
    throw new Error(
      "Recovery requires --confirm-stopped after you stop the bridge and independently confirm its Claude process and tools have stopped",
    );
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(input.sessionId))
    throw new Error("Recovery requires an exact Claude session UUID");
  const databaseFile = path.join(input.home, "bridge.sqlite");
  const nativeFile = path.join(input.home, "native-conversations-claude.sqlite");
  if (!existsSync(databaseFile) || !existsSync(nativeFile))
    throw new Error("Existing bridge and Claude conversation ledgers are required for recovery");
  assertStopped(input.home);
  const ownership = SqliteStore.open(databaseFile);
  let native: NativeConversationStore | undefined;
  let release: (() => void) | undefined;
  try {
    const owner = acquireRuntimeOwner({ store: ownership, onOwnershipLost: () => {} });
    release = () => {
      owner.release();
    };
    owner.assertOwned();
    assertStopped(input.home);
    native = new NativeConversationStore(nativeFile);
    const conversations = native
      .listConversations()
      .filter((entry) => entry.threadId === input.sessionId);
    const conversation = conversations[0];
    if (
      conversations.length !== 1 ||
      conversation === undefined ||
      conversation.activeTurnId === undefined ||
      conversation.state === "idle"
    )
      throw new Error(
        "Claude recovery requires one mapped conversation with an identified unresolved turn",
      );
    const turnId = conversation.activeTurnId;
    const deliveries = native.listDeliveriesForConversation(conversation.key);
    const originals = deliveries.filter(
      (entry) =>
        entry.nativeTurnId === turnId &&
        entry.rootEventId === undefined &&
        entry.unadmittedTurnId === undefined,
    );
    const original = originals[0];
    if (
      originals.length !== 1 ||
      original === undefined ||
      (original.completionStatus !== undefined && original.completionStatus !== "uncertain")
    )
      throw new Error("Claude recovery cannot identify the original uncertain dispatch");
    const directory = path.join(input.home, "claude");
    const sessionFile = path.join(directory, `${input.sessionId}.json`);
    const source = readFileSync(sessionFile, "utf8");
    const session: unknown = JSON.parse(source);
    if (
      !record(session) ||
      session.id !== input.sessionId ||
      session.cwd !== conversation.cwd ||
      typeof session.initialized !== "boolean" ||
      !Array.isArray(session.turns)
    )
      throw new Error("The Claude session evidence does not match its mapped conversation");
    const unresolved = session.turns.filter(
      (turn: unknown) => record(turn) && turn.status === "inProgress",
    );
    const turn: unknown = unresolved[0];
    if (
      unresolved.length !== 1 ||
      !record(turn) ||
      turn.id !== turnId ||
      session.turns.at(-1) !== turn
    )
      throw new Error("The Claude session does not identify exactly one final unresolved turn");
    const confirmedAt = new Date().toISOString();
    const receiptId = randomUUID();
    const evidenceFile = path.join(
      directory,
      `${input.sessionId}-${receiptId}-before-recovery.json`,
    );
    const recoveryRecord = path.join(
      directory,
      `${input.sessionId}-${receiptId}-reconciliation.json`,
    );
    const receipt = {
      kind: "operator-confirmed-stopped",
      sessionId: input.sessionId,
      turnId,
      confirmedAt,
      originalStatus: "inProgress",
      originalEvidence: path.basename(evidenceFile),
      originalSha256: createHash("sha256").update(source).digest("hex"),
      attestation:
        "The operator confirmed the bridge, Claude process, and independent tools have stopped. The outcome remains unknown and no prompt was replayed.",
    };
    writeFileSync(evidenceFile, source, { mode: 0o600, flag: "wx" });
    writeFileSync(recoveryRecord, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    owner.assertOwned();
    if (original.completionStatus === undefined)
      native.complete(
        original.eventId,
        "This Claude Code turn ended without a confirmed result. Its processes were confirmed stopped locally; its outcome remains unknown and the request has not been replayed.",
        "uncertain",
      );
    for (const delivery of deliveries) {
      if (delivery.unadmittedTurnId === turnId && delivery.completionStatus === undefined)
        native.complete(
          delivery.eventId,
          "This queued instruction was canceled during local Claude recovery. Send it again to start it.",
          "failed",
        );
    }
    const temporary = `${sessionFile}.${receiptId}.tmp`;
    try {
      const turns = session.turns.map((entry: unknown) => {
        if (entry !== turn) return entry;
        return {
          ...turn,
          status: "interrupted",
          operatorReconciliation: path.basename(recoveryRecord),
          error: { message: receipt.attestation },
        };
      });
      owner.assertOwned();
      writeFileSync(temporary, `${JSON.stringify({ ...session, turns })}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, sessionFile);
    } finally {
      rmSync(temporary, { force: true });
    }
    owner.assertOwned();
    if (!native.reconcileTerminal(conversation.key, input.sessionId, turnId))
      throw new Error(
        "Operator reconciliation was recorded, but the conversation state changed; restart the preserved runtime to reconcile it",
      );
    return { sessionId: input.sessionId, turnId, recoveryRecord };
  } finally {
    try {
      native?.close();
    } finally {
      try {
        release?.();
      } finally {
        ownership.close();
      }
    }
  }
}
