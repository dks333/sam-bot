import { randomUUID } from "node:crypto";

import type { RuntimeOwnerRecord, SqliteStore } from "../persistence/sqlite.js";

export type RuntimeProcessState = "alive" | "dead" | "unknown";

export interface RuntimeOwnerOptions {
  heartbeatIntervalMs?: number;
  now?: () => Date;
  onOwnershipLost: (error: Error) => void;
  probeProcess?: (pid: number) => RuntimeProcessState;
  store: Pick<
    SqliteStore,
    "getRuntimeOwner" | "claimRuntimeOwner" | "heartbeatRuntimeOwner" | "releaseRuntimeOwner"
  >;
}

export function probeRuntimeProcess(pid: number): RuntimeProcessState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return "dead";
    }
    return "unknown";
  }
}

export class RuntimeOwnerLease {
  readonly acquiredAt: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly #now: () => Date;
  readonly #onOwnershipLost: (error: Error) => void;
  readonly #store: RuntimeOwnerOptions["store"];
  #failure: Error | undefined;
  #released = false;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(record: RuntimeOwnerRecord, options: RuntimeOwnerOptions) {
    this.acquiredAt = record.acquiredAt;
    this.ownerId = record.ownerId;
    this.pid = record.pid;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#onOwnershipLost = options.onOwnershipLost;
    this.#timer = setInterval(() => {
      try {
        this.heartbeat();
      } catch (error) {
        this.#loseOwnership(
          error instanceof Error ? error : new Error("Runtime ownership heartbeat failed"),
        );
      }
    }, options.heartbeatIntervalMs ?? 15_000);
    this.#timer.unref();
  }

  assertOwned(): void {
    this.#assertActive();
    try {
      const owner = this.#store.getRuntimeOwner();
      if (owner?.ownerId !== this.ownerId || owner.pid !== this.pid) {
        throw new Error("Runtime execution ownership was lost");
      }
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Runtime ownership could not be verified");
      this.#loseOwnership(failure);
      throw failure;
    }
  }

  heartbeat(): void {
    this.#assertActive();
    try {
      if (!this.#store.heartbeatRuntimeOwner(this, this.#now().toISOString())) {
        throw new Error("Runtime execution ownership was lost");
      }
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Runtime ownership heartbeat failed");
      this.#loseOwnership(failure);
      throw failure;
    }
  }

  release(): boolean {
    if (this.#released) {
      return false;
    }
    this.#released = true;
    this.#stopHeartbeat();
    return this.#store.releaseRuntimeOwner(this);
  }

  #assertActive(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#released) {
      throw new Error("Runtime execution ownership has already been released");
    }
  }

  #loseOwnership(error: Error): void {
    if (this.#failure !== undefined || this.#released) {
      return;
    }
    this.#failure = error;
    this.#stopHeartbeat();
    this.#onOwnershipLost(error);
  }

  #stopHeartbeat(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

export function acquireRuntimeOwner(options: RuntimeOwnerOptions): RuntimeOwnerLease {
  const interval = options.heartbeatIntervalMs ?? 15_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483_647) {
    throw new Error("Runtime ownership heartbeat interval must be a positive timer duration");
  }
  const now = options.now ?? (() => new Date());
  const probeProcess = options.probeProcess ?? probeRuntimeProcess;
  const acquiredAt = now().toISOString();
  const record: RuntimeOwnerRecord = {
    acquiredAt,
    heartbeatAt: acquiredAt,
    ownerId: randomUUID(),
    pid: process.pid,
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prior = options.store.getRuntimeOwner();
    if (prior !== undefined) {
      const state = probeProcess(prior.pid);
      if (state !== "dead") {
        throw new Error(
          `Another runtime owns this database (PID ${prior.pid}; process ${state}). Stop that process before starting another bridge.`,
        );
      }
    }
    if (options.store.claimRuntimeOwner(record, prior)) {
      return new RuntimeOwnerLease(record, options);
    }
  }
  throw new Error("Runtime execution ownership changed during acquisition; startup was refused");
}
