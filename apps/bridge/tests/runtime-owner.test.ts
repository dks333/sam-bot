import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteStore, type RuntimeOwnerRecord } from "../src/persistence/sqlite.js";
import {
  acquireRuntimeOwner,
  probeRuntimeProcess,
  type RuntimeOwnerLease,
} from "../src/runtime/runtime-owner.js";

const resources: { directory: string; leases: RuntimeOwnerLease[]; stores: SqliteStore[] }[] = [];
const acquiredAt = "2026-10-15T10:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    for (const lease of resource.leases) {
      lease.release();
    }
    for (const store of resource.stores) {
      store.close();
    }
    rmSync(resource.directory, { force: true, recursive: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "runtime-owner-"));
  const databasePath = path.join(directory, "bridge.sqlite");
  const store = SqliteStore.open(databasePath);
  const peer = SqliteStore.open(databasePath);
  const leases: RuntimeOwnerLease[] = [];
  resources.push({ directory, leases, stores: [store, peer] });
  const onOwnershipLost = vi.fn();
  const acquire = (options: Parameters<typeof acquireRuntimeOwner>[0]) => {
    const lease = acquireRuntimeOwner(options);
    leases.push(lease);
    return lease;
  };
  return { acquire, onOwnershipLost, peer, store };
}

function ownerRecord(ownerId: string, pid = 123456): RuntimeOwnerRecord {
  return { acquiredAt, heartbeatAt: acquiredAt, ownerId, pid };
}

describe("runtime execution ownership", () => {
  it("allows only one runtime across independent connections to the same database", () => {
    const { acquire, onOwnershipLost, peer, store } = fixture();
    const lease = acquire({ onOwnershipLost, store });
    expect(store.getRuntimeOwner()).toMatchObject({ ownerId: lease.ownerId, pid: process.pid });
    expect(() => acquire({ onOwnershipLost, store: peer })).toThrow("Another runtime owns");
    lease.assertOwned();
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    expect(store.getRuntimeOwner()).toBeUndefined();
    const successor = acquire({ onOwnershipLost, store: peer });
    expect(successor.ownerId).not.toBe(lease.ownerId);
  });

  it("refuses stale heartbeats and reused live PIDs without attempting replacement", () => {
    const { acquire, onOwnershipLost, store } = fixture();
    const old = { ...ownerRecord("old-owner", process.pid), heartbeatAt: "2001-01-01T00:00:00Z" };
    expect(store.claimRuntimeOwner(old)).toBe(true);
    expect(() => acquire({ onOwnershipLost, store })).toThrow("process alive");
    expect(store.getRuntimeOwner()).toEqual(old);
  });

  it("reclaims a proven dead owner through an atomic compare-and-swap", () => {
    const { acquire, onOwnershipLost, peer, store } = fixture();
    const old = ownerRecord("dead-owner");
    expect(store.claimRuntimeOwner(old)).toBe(true);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    const lease = acquire({ onOwnershipLost, store: peer });
    expect(kill).toHaveBeenCalledWith(old.pid, 0);
    expect(store.getRuntimeOwner()?.ownerId).toBe(lease.ownerId);
    expect(store.releaseRuntimeOwner(old)).toBe(false);
    expect(store.heartbeatRuntimeOwner(old, new Date().toISOString())).toBe(false);
    lease.assertOwned();
  });

  it("fails closed for permission-denied and unrecognized process probe errors", () => {
    const { acquire, onOwnershipLost, store } = fixture();
    const old = ownerRecord("unverifiable-owner");
    store.claimRuntimeOwner(old);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
    });
    expect(() => acquire({ onOwnershipLost, store })).toThrow("process unknown");
    kill.mockImplementation(() => {
      throw new Error("Unexpected process failure");
    });
    expect(probeRuntimeProcess(old.pid)).toBe("unknown");
    expect(store.getRuntimeOwner()).toEqual(old);
  });

  it("allows only one contender to replace the same dead owner", () => {
    const { peer, store } = fixture();
    const old = ownerRecord("dead-owner");
    store.claimRuntimeOwner(old);
    const first = ownerRecord("first-owner", process.pid);
    const second = ownerRecord("second-owner", process.pid);
    expect(peer.claimRuntimeOwner(first, old)).toBe(true);
    expect(store.claimRuntimeOwner(second, old)).toBe(false);
    expect(store.claimRuntimeOwner(second)).toBe(false);
    expect(store.getRuntimeOwner()).toEqual(first);
  });

  it("rechecks the winner after a competing takeover instead of stealing its live lease", () => {
    const { acquire, onOwnershipLost, peer, store } = fixture();
    const old = ownerRecord("dead-owner");
    const winner = ownerRecord("winning-owner", process.pid);
    store.claimRuntimeOwner(old);
    const probeProcess = vi.fn((pid: number) => {
      if (pid === old.pid) {
        expect(peer.claimRuntimeOwner(winner, old)).toBe(true);
        return "dead";
      }
      return "alive";
    });
    expect(() => acquire({ onOwnershipLost, probeProcess, store })).toThrow("process alive");
    expect(store.getRuntimeOwner()).toEqual(winner);
  });

  it("heartbeats are observability and ownership loss fences the owner once", () => {
    vi.useFakeTimers();
    const { acquire, onOwnershipLost, peer, store } = fixture();
    let now = new Date(acquiredAt);
    const lease = acquire({
      heartbeatIntervalMs: 100,
      now: () => now,
      onOwnershipLost,
      store,
    });
    now = new Date("2026-10-15T10:00:01.000Z");
    vi.advanceTimersByTime(100);
    expect(store.getRuntimeOwner()?.heartbeatAt).toBe(now.toISOString());
    const successor = ownerRecord("external-owner", process.pid);
    expect(peer.claimRuntimeOwner(successor, lease)).toBe(true);
    vi.advanceTimersByTime(100);
    expect(onOwnershipLost).toHaveBeenCalledOnce();
    expect(() => lease.assertOwned()).toThrow("ownership was lost");
    expect(() => lease.heartbeat()).toThrow("ownership was lost");
    expect(lease.release()).toBe(false);
    expect(peer.getRuntimeOwner()).toEqual(successor);
    vi.advanceTimersByTime(1_000);
    expect(onOwnershipLost).toHaveBeenCalledOnce();
  });

  it("fences execution when the ownership database becomes unavailable", () => {
    const { acquire, onOwnershipLost, store } = fixture();
    const lease = acquire({ onOwnershipLost, store });
    vi.spyOn(store, "heartbeatRuntimeOwner").mockImplementation(() => {
      throw new Error("Database unavailable");
    });
    expect(() => lease.heartbeat()).toThrow("Database unavailable");
    expect(onOwnershipLost).toHaveBeenCalledOnce();
    expect(() => lease.assertOwned()).toThrow("Database unavailable");
  });
});
