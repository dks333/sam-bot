import type { NativeActivitySnapshot } from "../bridge/native-activity.js";
import type {
  AgentSessionStatus,
  AgentSessionStatusResult,
  AgentSessionStatusWriter,
  AgentSessionTarget,
} from "./agent-session-status.js";

interface ThreadStatus {
  target: AgentSessionTarget;
  owners: Set<string>;
  desired: AgentSessionStatus;
  applied?: AgentSessionStatus;
  appliedAt?: number;
  dirty: boolean;
  disabled: boolean;
  retryAt: number;
  failures: number;
  refresh?: ReturnType<typeof setTimeout>;
}

interface TeamStatus {
  threads: Set<ThreadStatus>;
  writing: boolean;
  disabled: boolean;
  nextAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface StatusLogger {
  warn(details: { teamId: string; reason: string }, message: string): void;
}

const minimumIntervalMs = 1_500;
const refreshIntervalMs = 45 * 60_000;
const shutdownTimeoutMs = 6_000;

export class AgentStatusCoordinator {
  readonly #writer: AgentSessionStatusWriter;
  readonly #logger: StatusLogger;
  readonly #assertOwned: (() => void) | undefined;
  readonly #confirmExecuting: ((snapshot: NativeActivitySnapshot) => boolean) | undefined;
  readonly #snapshots = new Map<string, NativeActivitySnapshot>();
  readonly #threads = new Map<string, ThreadStatus>();
  readonly #teams = new Map<string, TeamStatus>();
  readonly #writes = new Set<Promise<void>>();
  #closed = false;
  #draining = false;
  #resolveDrain: (() => void) | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: {
    writer: AgentSessionStatusWriter;
    logger: StatusLogger;
    assertOwned?: () => void;
    confirmExecuting?: (snapshot: NativeActivitySnapshot) => boolean;
  }) {
    this.#writer = options.writer;
    this.#logger = options.logger;
    this.#assertOwned = options.assertOwned;
    this.#confirmExecuting = options.confirmExecuting;
  }

  observe(snapshot: NativeActivitySnapshot): void {
    if (this.#closed || this.#draining) return;
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      !Number.isSafeInteger(snapshot.pendingInputCount) ||
      snapshot.pendingInputCount < 0
    )
      return;
    const previous = this.#snapshots.get(snapshot.conversationKey);
    if (previous !== undefined) {
      if (snapshot.revision <= previous.revision) return;
      if (
        snapshot.teamId !== previous.teamId ||
        snapshot.userId !== previous.userId ||
        snapshot.channelId !== previous.channelId ||
        snapshot.threadTs !== previous.threadTs
      ) {
        this.#warn(snapshot.teamId, "conversation_identity_changed");
        return;
      }
    }
    this.#snapshots.set(snapshot.conversationKey, { ...snapshot });
    const key = JSON.stringify([snapshot.teamId, snapshot.channelId, snapshot.threadTs]);
    let thread = this.#threads.get(key);
    if (thread === undefined) {
      thread = {
        target: {
          teamId: snapshot.teamId,
          channelId: snapshot.channelId,
          threadTs: snapshot.threadTs,
        },
        owners: new Set(),
        desired: "active",
        dirty: false,
        disabled: false,
        retryAt: 0,
        failures: 0,
      };
      this.#threads.set(key, thread);
    }
    let team = this.#teams.get(snapshot.teamId);
    if (team === undefined) {
      team = { threads: new Set(), writing: false, disabled: false, nextAt: 0 };
      this.#teams.set(snapshot.teamId, team);
    }
    team.threads.add(thread);
    thread.owners.add(snapshot.conversationKey);
    const desired = this.#derive(thread);
    if (desired !== thread.desired) {
      thread.desired = desired;
      thread.dirty = true;
      thread.retryAt = 0;
      thread.failures = 0;
    }
    if (thread.applied !== desired) thread.dirty = true;
    if (desired !== "processing") this.#clearRefresh(thread);
    else this.#refresh(thread, team);
    this.#pump(team);
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#draining = true;
    for (const team of this.#teams.values()) {
      if (team.timer !== undefined) clearTimeout(team.timer);
      delete team.timer;
    }
    for (const thread of this.#threads.values()) this.#clearRefresh(thread);
    this.#closing = this.#finishClose();
    return this.#closing;
  }

  #derive(thread: ThreadStatus): AgentSessionStatus {
    let waiting = false;
    for (const owner of thread.owners) {
      const snapshot = this.#snapshots.get(owner);
      if (snapshot === undefined) continue;
      if (snapshot.phase === "executing") return "processing";
      if (
        snapshot.phase === "waiting" ||
        snapshot.phase === "uncertain" ||
        snapshot.needsReconciliation === true ||
        snapshot.pendingInputCount > 0
      )
        waiting = true;
    }
    if (waiting) return "suspended";
    return "active";
  }

  #pump(team: TeamStatus): void {
    if (this.#closed || team.disabled || team.writing) return;
    if (team.timer !== undefined) clearTimeout(team.timer);
    delete team.timer;
    const pending = [...team.threads].filter(
      (thread) =>
        thread.dirty && !thread.disabled && (!this.#draining || thread.desired !== "processing"),
    );
    if (pending.length === 0) return;
    const now = Date.now();
    const eligible = pending.filter((thread) => Math.max(thread.retryAt, team.nextAt) <= now);
    let selected = eligible.find((thread) => thread.desired !== "processing");
    selected ??= eligible[0];
    if (selected === undefined) {
      const next = Math.min(...pending.map((thread) => Math.max(thread.retryAt, team.nextAt)));
      team.timer = setTimeout(() => {
        delete team.timer;
        this.#pump(team);
      }, next - now);
      team.timer.unref();
      return;
    }
    team.writing = true;
    const write = this.#write(team, selected).catch(() => {});
    this.#writes.add(write);
    void write.then(() => {
      this.#writes.delete(write);
      this.#checkDrained();
    });
  }

  async #write(team: TeamStatus, thread: ThreadStatus): Promise<void> {
    const desired = thread.desired;
    if (desired === "processing" && thread.applied === "processing" && !this.#confirmed(thread)) {
      team.writing = false;
      thread.dirty = false;
      this.#pump(team);
      return;
    }
    let result: AgentSessionStatusResult;
    let owned = true;
    try {
      this.#assertOwned?.();
    } catch {
      owned = false;
    }
    if (!owned) result = { kind: "unavailable", scope: "team", reason: "runtime_ownership_lost" };
    else {
      try {
        result = await this.#writer.setStatus(thread.target, desired);
      } catch {
        result = { kind: "retry", reason: "status_writer_failed" };
      }
    }
    const now = Date.now();
    team.writing = false;
    team.nextAt = now + minimumIntervalMs;
    if (this.#closed) return;
    if (result.kind === "applied") {
      thread.applied = desired;
      thread.appliedAt = now;
      thread.dirty = thread.desired !== desired;
      thread.retryAt = 0;
      thread.failures = 0;
      this.#refresh(thread, team);
    } else if (result.kind === "rate-limited") {
      team.nextAt = Math.max(team.nextAt, now + result.retryAfterMs);
      thread.dirty = true;
    } else if (result.kind === "unavailable") {
      if (result.scope === "team") {
        team.disabled = true;
        for (const entry of team.threads) this.#clearRefresh(entry);
      } else thread.disabled = true;
      this.#clearRefresh(thread);
      this.#warn(thread.target.teamId, result.reason);
    } else {
      thread.failures += 1;
      thread.retryAt = now + Math.min(60_000, 5_000 * 2 ** Math.min(thread.failures - 1, 4));
      thread.dirty = true;
      this.#warn(thread.target.teamId, result.reason);
    }
    this.#pump(team);
  }

  #refresh(thread: ThreadStatus, team: TeamStatus): void {
    if (
      this.#closed ||
      this.#draining ||
      team.disabled ||
      thread.disabled ||
      thread.desired !== "processing" ||
      thread.applied !== "processing" ||
      thread.appliedAt === undefined ||
      thread.refresh !== undefined
    )
      return;
    const next = Math.max(0, thread.appliedAt + refreshIntervalMs - Date.now());
    thread.refresh = setTimeout(() => {
      delete thread.refresh;
      if (!this.#closed && this.#confirmed(thread) && this.#derive(thread) === "processing") {
        thread.dirty = true;
        this.#pump(team);
      }
    }, next);
    thread.refresh.unref();
  }

  #confirmed(thread: ThreadStatus): boolean {
    return [...thread.owners].some((owner) => {
      const snapshot = this.#snapshots.get(owner);
      if (
        snapshot === undefined ||
        snapshot.phase !== "executing" ||
        snapshot.nativeTurnId === undefined
      )
        return false;
      try {
        return this.#confirmExecuting?.(snapshot) ?? true;
      } catch {
        return false;
      }
    });
  }

  #clearRefresh(thread: ThreadStatus): void {
    if (thread.refresh !== undefined) clearTimeout(thread.refresh);
    delete thread.refresh;
  }

  #warn(teamId: string, reason: string): void {
    try {
      this.#logger.warn({ teamId, reason }, "Slack agent status is unavailable");
    } catch {}
  }

  #checkDrained(): void {
    if (!this.#draining || this.#writes.size > 0) return;
    for (const team of this.#teams.values()) {
      if (team.writing) return;
      if (
        !team.disabled &&
        [...team.threads].some(
          (thread) => thread.dirty && !thread.disabled && thread.desired !== "processing",
        )
      )
        return;
    }
    this.#resolveDrain?.();
  }

  async #finishClose(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const drained = new Promise<void>((resolve) => {
      this.#resolveDrain = resolve;
    });
    for (const team of this.#teams.values()) this.#pump(team);
    this.#checkDrained();
    try {
      await Promise.race([
        drained,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, shutdownTimeoutMs);
          timeout.unref();
        }),
      ]);
    } finally {
      this.#closed = true;
      this.#resolveDrain = undefined;
      if (timeout !== undefined) clearTimeout(timeout);
      for (const team of this.#teams.values()) {
        if (team.timer !== undefined) clearTimeout(team.timer);
        delete team.timer;
      }
    }
  }
}
