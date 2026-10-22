import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeActivitySnapshot } from "../src/bridge/native-activity.js";
import type {
  AgentSessionStatusResult,
  AgentSessionStatusWriter,
} from "../src/slack/agent-session-status.js";
import { AgentStatusCoordinator } from "../src/slack/agent-status-coordinator.js";

const coordinators: AgentStatusCoordinator[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    const closing = coordinator.close();
    await vi.advanceTimersByTimeAsync(6_000);
    await closing;
  }
  vi.useRealTimers();
});

function snapshot(overrides: Partial<NativeActivitySnapshot> = {}): NativeActivitySnapshot {
  return {
    conversationKey: "synthetic-owner-one",
    teamId: "T_SYNTHETIC",
    userId: "U_SYNTHETIC",
    channelId: "C_SYNTHETIC",
    threadTs: "123.456",
    nativeThreadId: "native-thread-one",
    nativeTurnId: "native-turn-one",
    revision: 1,
    phase: "executing",
    pendingInputCount: 0,
    finalPendingDelivery: false,
    ...overrides,
  };
}

function deferred() {
  let resolve = (value: AgentSessionStatusResult) => {
    void value;
  };
  const promise = new Promise<AgentSessionStatusResult>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture(
  options: {
    confirmExecuting?: (snapshot: NativeActivitySnapshot) => boolean;
    assertOwned?: () => void;
  } = {},
) {
  const setStatus = vi.fn<AgentSessionStatusWriter["setStatus"]>();
  setStatus.mockResolvedValue({ kind: "applied" });
  const logger = { warn: vi.fn() };
  const coordinator = new AgentStatusCoordinator({ writer: { setStatus }, logger, ...options });
  coordinators.push(coordinator);
  return { coordinator, setStatus, logger };
}

function statuses(value: ReturnType<typeof fixture>) {
  return value.setStatus.mock.calls.map((call) => call[1]);
}

describe("Slack agent status lifecycle coordination", () => {
  it("aggregates all owners sharing a Slack thread and clears execution before final delivery", async () => {
    const value = fixture();
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(
      snapshot({
        conversationKey: "synthetic-owner-two",
        userId: "U_OTHER",
        phase: "waiting",
        pendingInputCount: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing"]);
    value.coordinator.observe(snapshot({ revision: 2, phase: "idle", finalPendingDelivery: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(value)).toEqual(["processing", "suspended"]);
    value.coordinator.observe(
      snapshot({
        conversationKey: "synthetic-owner-two",
        userId: "U_OTHER",
        revision: 2,
        phase: "idle",
      }),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing", "suspended", "active"]);
  });

  it("never treats a final awaiting Slack delivery as executing", async () => {
    const value = fixture();
    value.coordinator.observe(snapshot({ phase: "idle", finalPendingDelivery: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(value)).toEqual(["active"]);
  });

  it("shows suspended for an ambiguous final that needs reconciliation", async () => {
    const value = fixture();
    value.coordinator.observe(
      snapshot({ phase: "idle", finalPendingDelivery: true, needsReconciliation: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(value)).toEqual(["suspended"]);
  });

  it("keeps a new executing turn working despite an older ambiguous final", async () => {
    const value = fixture({ confirmExecuting: () => true });
    value.coordinator.observe(snapshot({ finalPendingDelivery: true, needsReconciliation: true }));
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(statuses(value)).toEqual(["processing", "processing"]);
  });

  it("projects restart uncertainty to suspended without replaying processing", async () => {
    const value = fixture();
    value.coordinator.observe(snapshot({ phase: "uncertain" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(value)).toEqual(["suspended"]);
  });

  it("rejects delayed revisions and owner identity changes", async () => {
    const value = fixture();
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 3, phase: "idle" }));
    value.coordinator.observe(snapshot({ revision: 2 }));
    value.coordinator.observe(snapshot({ revision: 4, userId: "U_OTHER" }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing", "active"]);
    expect(value.logger.warn).toHaveBeenCalledWith(
      { teamId: "T_SYNTHETIC", reason: "conversation_identity_changed" },
      expect.any(String),
    );
  });

  it("coalesces changes during an in-flight write and serializes the final correction", async () => {
    const value = fixture();
    const first = deferred();
    value.setStatus.mockReturnValueOnce(first.promise);
    value.coordinator.observe(snapshot());
    value.coordinator.observe(snapshot({ revision: 2, phase: "waiting" }));
    value.coordinator.observe(snapshot({ revision: 3 }));
    value.coordinator.observe(snapshot({ revision: 4, phase: "idle" }));
    expect(value.setStatus).toHaveBeenCalledTimes(1);
    first.resolve({ kind: "applied" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing", "active"]);
  });

  it("respects workspace-wide 429 cooldown and retries only the latest desired states", async () => {
    const value = fixture();
    value.setStatus.mockResolvedValueOnce({ kind: "rate-limited", retryAfterMs: 60_000 });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 2, phase: "idle" }));
    value.coordinator.observe(
      snapshot({ conversationKey: "synthetic-other-root", threadTs: "123.457" }),
    );
    value.coordinator.observe(
      snapshot({ conversationKey: "synthetic-other-team", teamId: "T_OTHER" }),
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(statuses(value)).toEqual(["processing", "processing"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses(value)).toEqual(["processing", "processing", "active"]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing", "processing", "active", "processing"]);
    expect(value.setStatus.mock.calls[2]?.[0].threadTs).toBe("123.456");
    expect(value.setStatus.mock.calls[3]?.[0].threadTs).toBe("123.457");
  });

  it("backs off transient failures and never lets a rejected writer or logger escape", async () => {
    const value = fixture();
    value.setStatus.mockRejectedValueOnce(new Error("Synthetic temporary failure"));
    value.logger.warn.mockImplementation(() => {
      throw new Error("Synthetic logger failure");
    });
    expect(() => value.coordinator.observe(snapshot())).not.toThrow();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(value.setStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses(value)).toEqual(["processing", "processing"]);
  });

  it("disables unavailable workspace features while other workspaces remain independent", async () => {
    const value = fixture();
    value.setStatus.mockResolvedValueOnce({
      kind: "unavailable",
      scope: "team",
      reason: "feature_disabled",
    });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 2, phase: "idle" }));
    value.coordinator.observe(
      snapshot({ conversationKey: "synthetic-other-root", threadTs: "123.457" }),
    );
    value.coordinator.observe(
      snapshot({ conversationKey: "synthetic-other-team", teamId: "T_OTHER", phase: "idle" }),
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(statuses(value)).toEqual(["processing", "active"]);
  });

  it("limits unavailable channel failures to the affected thread", async () => {
    const value = fixture();
    value.setStatus.mockResolvedValueOnce({
      kind: "unavailable",
      scope: "thread",
      reason: "channel_not_found",
    });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(
      snapshot({ conversationKey: "synthetic-other-root", threadTs: "123.457", phase: "idle" }),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing", "active"]);
  });

  it.each([true, false])(
    "refreshes processing only with current execution confirmation %s",
    async (confirmed) => {
      const confirmExecuting = vi.fn(() => confirmed);
      const value = fixture({ confirmExecuting });
      value.coordinator.observe(snapshot());
      await vi.advanceTimersByTimeAsync(45 * 60_000);
      expect(confirmExecuting).toHaveBeenCalledWith(snapshot());
      expect(value.setStatus).toHaveBeenCalledTimes(confirmed ? 2 : 1);
    },
  );

  it("rechecks execution before a rate-limited processing refresh is retried", async () => {
    let confirmed = true;
    const value = fixture({ confirmExecuting: () => confirmed });
    value.setStatus.mockResolvedValueOnce({ kind: "applied" });
    value.setStatus.mockResolvedValueOnce({ kind: "rate-limited", retryAfterMs: 10_000 });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(value.setStatus).toHaveBeenCalledTimes(2);
    confirmed = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(value.setStatus).toHaveBeenCalledTimes(2);
  });

  it("never refreshes an unconfirmed dispatch or a task that begins waiting", async () => {
    const value = fixture();
    const dispatch = snapshot();
    delete dispatch.nativeTurnId;
    value.coordinator.observe(dispatch);
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(value.setStatus).toHaveBeenCalledTimes(1);
    value.coordinator.observe(snapshot({ revision: 2, phase: "waiting", pendingInputCount: 1 }));
    await vi.advanceTimersByTimeAsync(45 * 60_000);
    expect(statuses(value)).toEqual(["processing", "suspended"]);
  });

  it("rechecks ownership after queued delay and does not send from a fenced runtime", async () => {
    let owned = true;
    const value = fixture({
      assertOwned() {
        if (!owned) throw new Error("Synthetic lost lease");
      },
    });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 2, phase: "idle" }));
    owned = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(statuses(value)).toEqual(["processing"]);
    expect(value.logger.warn).toHaveBeenCalledWith(
      { teamId: "T_SYNTHETIC", reason: "runtime_ownership_lost" },
      expect.any(String),
    );
  });

  it("drains the latest non-processing status on close and refuses new execution", async () => {
    const value = fixture();
    const first = deferred();
    value.setStatus.mockReturnValueOnce(first.promise);
    value.coordinator.observe(snapshot());
    value.coordinator.observe(snapshot({ revision: 2, phase: "idle" }));
    let closed = false;
    const closing = value.coordinator.close();
    expect(value.coordinator.close()).toBe(closing);
    void closing.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(closed).toBe(false);
    value.coordinator.observe(snapshot({ revision: 3 }));
    first.resolve({ kind: "applied" });
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    value.coordinator.observe(snapshot({ revision: 4 }));
    expect(statuses(value)).toEqual(["processing", "active"]);
  });

  it("publishes suspended for disconnected work before closing", async () => {
    const value = fixture();
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 2, phase: "uncertain" }));
    const closing = value.coordinator.close();
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    expect(statuses(value)).toEqual(["processing", "suspended"]);
  });

  it("does not send already queued processing work during shutdown", async () => {
    const value = fixture();
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(
      snapshot({ conversationKey: "synthetic-other-root", threadTs: "123.457" }),
    );
    await value.coordinator.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(statuses(value)).toEqual(["processing"]);
  });

  it("fences queued shutdown mutations after runtime ownership is lost", async () => {
    let owned = true;
    const value = fixture({
      assertOwned() {
        if (!owned) throw new Error("Synthetic lost lease");
      },
    });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 2, phase: "uncertain" }));
    owned = false;
    const closing = value.coordinator.close();
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    expect(statuses(value)).toEqual(["processing"]);
    expect(value.logger.warn).toHaveBeenCalledWith(
      { teamId: "T_SYNTHETIC", reason: "runtime_ownership_lost" },
      expect.any(String),
    );
  });

  it("retains the six-second shutdown bound during a long workspace cooldown", async () => {
    const value = fixture();
    value.setStatus.mockResolvedValueOnce({ kind: "rate-limited", retryAfterMs: 60_000 });
    value.coordinator.observe(snapshot());
    await vi.advanceTimersByTimeAsync(0);
    value.coordinator.observe(snapshot({ revision: 2, phase: "uncertain" }));
    const closing = value.coordinator.close();
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(closing).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(value.setStatus).toHaveBeenCalledTimes(1);
  });

  it("bounds shutdown even if a client never settles", async () => {
    const value = fixture();
    value.setStatus.mockReturnValueOnce(new Promise(() => {}));
    value.coordinator.observe(snapshot());
    const closing = value.coordinator.close();
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(closing).resolves.toBeUndefined();
  });
});
