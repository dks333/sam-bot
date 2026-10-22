import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recoverClaudeSession } from "../src/claude/recovery.js";
import { NativeConversationStore } from "../src/persistence/native-conversation-store.js";
import { SqliteStore } from "../src/persistence/sqlite.js";
import { acquireRuntimeOwner } from "../src/runtime/runtime-owner.js";

vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return { ...filesystem, renameSync: vi.fn(filesystem.renameSync) };
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "claude-recovery-"));
  directories.push(home);
  SqliteStore.open(path.join(home, "bridge.sqlite")).close();
  const file = path.join(home, "native-conversations-claude.sqlite");
  const native = new NativeConversationStore(file);
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const delivery = native.claim({
    eventId: "synthetic-event",
    teamId: "synthetic-team",
    userId: "synthetic-user",
    channelId: "synthetic-channel",
    threadTs: "100.000001",
    messageTs: "100.000002",
    text: "Synthetic interrupted task",
  });
  if (delivery === undefined) throw new Error("Synthetic delivery was not claimed");
  native.bind(delivery.conversationKey, sessionId, home);
  native.dispatch(delivery.eventId);
  native.started(delivery.eventId, turnId);
  const followup = native.claim({
    eventId: "synthetic-followup",
    teamId: "synthetic-team",
    userId: "synthetic-user",
    channelId: "synthetic-channel",
    threadTs: "100.000001",
    messageTs: "100.000003",
    text: "Synthetic queued follow-up",
  });
  if (followup === undefined) throw new Error("Synthetic follow-up was not claimed");
  native.steering(followup.eventId, turnId);
  native.markUnadmitted(followup.eventId, turnId);
  native.complete(delivery.eventId, "Original uncertain result", "uncertain");
  native.close();
  const directory = path.join(home, "claude");
  mkdirSync(directory, { mode: 0o700 });
  const sessionFile = path.join(directory, `${sessionId}.json`);
  const original = JSON.stringify({
    id: sessionId,
    cwd: home,
    initialized: true,
    turns: [
      {
        id: turnId,
        status: "inProgress",
        items: [{ id: "synthetic-item", type: "agentMessage", text: "Original evidence" }],
      },
    ],
  });
  writeFileSync(sessionFile, original, { mode: 0o600 });
  const recover = () =>
    recoverClaudeSession({ home, provider: "claude", sessionId, confirmedStopped: true });
  return { home, file, sessionFile, sessionId, turnId, original, delivery, followup, recover };
}

describe("explicit local Claude session recovery", () => {
  it("cancels queued follow-ups before publishing terminal evidence even if publication fails", () => {
    const harness = fixture();
    let queuedAtPublication: number | undefined;
    vi.mocked(renameSync).mockImplementationOnce(() => {
      const native = new NativeConversationStore(harness.file);
      try {
        queuedAtPublication = native.listUnadmitted().length;
      } finally {
        native.close();
      }
      throw new Error("Synthetic recovery publication failure");
    });
    expect(() => harness.recover()).toThrow("Synthetic recovery publication failure");
    expect(queuedAtPublication).toBe(0);
    expect(readFileSync(harness.sessionFile, "utf8")).toBe(harness.original);
    const native = new NativeConversationStore(harness.file);
    try {
      expect(native.getConversation(harness.delivery.conversationKey)?.state).toBe("uncertain");
      expect(native.getDelivery(harness.followup.eventId)?.completionStatus).toBe("failed");
      expect(native.listUnadmitted()).toHaveLength(0);
    } finally {
      native.close();
    }
  });

  it("preserves original evidence and final delivery while acknowledging stopped work without replay", () => {
    const harness = fixture();
    const recovered = harness.recover();
    expect(recovered).toMatchObject({ sessionId: harness.sessionId, turnId: harness.turnId });
    const receipt: unknown = JSON.parse(readFileSync(recovered.recoveryRecord, "utf8"));
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("originalEvidence" in receipt) ||
      typeof receipt.originalEvidence !== "string"
    )
      throw new Error("Synthetic recovery receipt is invalid");
    expect(receipt).toMatchObject({
      kind: "operator-confirmed-stopped",
      originalStatus: "inProgress",
      turnId: harness.turnId,
    });
    expect(readFileSync(path.join(harness.home, "claude", receipt.originalEvidence), "utf8")).toBe(
      harness.original,
    );
    expect(statSync(recovered.recoveryRecord).mode & 0o777).toBe(0o600);
    const session: unknown = JSON.parse(readFileSync(harness.sessionFile, "utf8"));
    expect(session).toMatchObject({
      turns: [
        {
          id: harness.turnId,
          status: "interrupted",
          operatorReconciliation: path.basename(recovered.recoveryRecord),
          items: [{ text: "Original evidence" }],
        },
      ],
    });
    const native = new NativeConversationStore(harness.file);
    try {
      expect(native.getConversation(harness.delivery.conversationKey)?.state).toBe("idle");
      expect(native.getDelivery(harness.delivery.eventId)).toMatchObject({
        finalText: "Original uncertain result",
        completionStatus: "uncertain",
      });
      expect(native.getDelivery(harness.followup.eventId)).toMatchObject({
        completionStatus: "failed",
        finalText: expect.stringContaining("canceled during local Claude recovery"),
      });
      expect(native.listUnadmitted()).toHaveLength(0);
      expect(native.pendingDeliveries()).toHaveLength(2);
    } finally {
      native.close();
    }
    expect(() => harness.recover()).toThrow("identified unresolved turn");
  });

  it("requires an explicit attestation and the configured Claude provider", () => {
    const harness = fixture();
    expect(() =>
      recoverClaudeSession({
        home: harness.home,
        provider: "claude",
        sessionId: harness.sessionId,
        confirmedStopped: false,
      }),
    ).toThrow("--confirm-stopped");
    expect(() =>
      recoverClaudeSession({
        home: harness.home,
        provider: "codex",
        sessionId: harness.sessionId,
        confirmedStopped: true,
      }),
    ).toThrow("Select the Claude provider");
    expect(readFileSync(harness.sessionFile, "utf8")).toBe(harness.original);
  });

  it("refuses a live health PID and an active runtime owner without changing session evidence", () => {
    const harness = fixture();
    const healthFile = path.join(harness.home, "runtime-health.json");
    writeFileSync(healthFile, JSON.stringify({ pid: process.pid }));
    expect(() => harness.recover()).toThrow("Stop the Slack bridge runtime");
    rmSync(healthFile);
    const ownership = SqliteStore.open(path.join(harness.home, "bridge.sqlite"));
    const owner = acquireRuntimeOwner({ store: ownership, onOwnershipLost: () => {} });
    try {
      expect(() => harness.recover()).toThrow("Another runtime owns this database");
    } finally {
      owner.release();
      ownership.close();
    }
    expect(readFileSync(harness.sessionFile, "utf8")).toBe(harness.original);
  });

  it("refuses ambiguous session evidence instead of guessing which dispatch stopped", () => {
    const harness = fixture();
    const modified = JSON.stringify({
      id: harness.sessionId,
      cwd: harness.home,
      initialized: true,
      turns: [
        { id: harness.turnId, status: "inProgress", items: [] },
        { id: randomUUID(), status: "inProgress", items: [] },
      ],
    });
    writeFileSync(harness.sessionFile, modified);
    expect(() => harness.recover()).toThrow("exactly one final unresolved turn");
    expect(readFileSync(harness.sessionFile, "utf8")).toBe(modified);
    expect(() =>
      recoverClaudeSession({
        home: harness.home,
        provider: "claude",
        sessionId: "../synthetic",
        confirmedStopped: true,
      }),
    ).toThrow("exact Claude session UUID");
  });
});
