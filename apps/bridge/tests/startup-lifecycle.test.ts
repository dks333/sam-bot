import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeStartup,
  registerStartupSignals,
  settleStartupCleanup,
  type StartupPhase,
} from "../src/runtime/startup-lifecycle.js";

afterEach(() => vi.useRealTimers());
const cancellablePhases: StartupPhase[] = ["native-initialization", "native-readiness", "recovery"];

describe("bounded runtime startup", () => {
  it("invalidates owned ready health before a registered SIGTERM handler cancels startup", () => {
    const signals = new EventEmitter();
    const startup = new RuntimeStartup({ assertOwned: () => undefined });
    startup.complete();
    let ready = true;
    const events: string[] = [];
    const shutdown = vi.fn(async (signal: string) => {
      startup.assertFailureReportable();
      ready = false;
      events.push("health-invalidated");
      startup.cancel(`Synthetic ${signal} shutdown`);
      events.push("cancelled");
    });
    registerStartupSignals(signals, startup, () => shutdown);
    signals.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(events).toEqual(["health-invalidated", "cancelled"]);
    expect(ready).toBe(false);
    expect(startup.signal.aborted).toBe(true);
  });

  it("cancels a registered signal before shutdown resources have been created", () => {
    const signals = new EventEmitter();
    const startup = new RuntimeStartup({ assertOwned: () => undefined });
    registerStartupSignals(signals, startup, () => undefined);
    signals.emit("SIGTERM");
    expect(() => startup.assertRunning()).toThrow("SIGTERM");
  });
  it("stops a stalled native initialization before subsequent startup work", async () => {
    vi.useFakeTimers();
    const phases: string[] = [];
    const startup = new RuntimeStartup({
      assertOwned: () => undefined,
      budgets: { "native-initialization": 20 },
      onPhase: (event) => phases.push(`${event.phase}:${event.state}`),
    });
    const pending = startup.run("native-initialization", () => new Promise<void>(() => undefined));
    const rejected = expect(pending).rejects.toThrow("native-initialization exceeded");
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    const connect = vi.fn(async () => undefined);
    await expect(startup.run("slack-connection", connect)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    expect(phases).toEqual(["native-initialization:starting", "native-initialization:failed"]);
  });

  it.each(cancellablePhases)(
    "cancels after %s resolves before any next stage or ready publication",
    async (phase) => {
      const startup = new RuntimeStartup({ assertOwned: () => undefined });
      const next = vi.fn(async () => undefined);
      await expect(
        startup.run(phase, async () => {
          await Promise.resolve();
          startup.cancel(`Synthetic ${phase} shutdown`);
        }),
      ).rejects.toThrow("shutdown");
      await expect(startup.run("slack-connection", next)).rejects.toThrow("shutdown");
      expect(next).not.toHaveBeenCalled();
      expect(() => startup.assertRunning()).toThrow("shutdown");
    },
  );

  it("closes a Socket Mode start that resolves after shutdown without publishing completion", async () => {
    let resolveStart: () => void = () => undefined;
    const pendingStart = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const stop = vi.fn(async () => undefined);
    const phases: string[] = [];
    const startup = new RuntimeStartup({
      assertOwned: () => undefined,
      onPhase: (event) => phases.push(event.state),
    });
    const starting = startup.run("slack-connection", () => pendingStart, stop);
    const rejected = expect(starting).rejects.toThrow("shutdown");
    await Promise.resolve();
    startup.cancel("Synthetic shutdown");
    await rejected;
    resolveStart();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(phases).toEqual(["starting"]);
    expect(() => startup.assertRunning()).toThrow("shutdown");
  });

  it("runs recovery steps in order under one phase budget", async () => {
    const events: string[] = [];
    const startup = new RuntimeStartup({
      assertOwned: () => undefined,
      onPhase: (event) => events.push(`${event.phase}:${event.state}`),
    });
    await startup.runSteps("recovery", [
      async () => {
        events.push("review-history");
      },
      async () => {
        events.push("task-recovery");
      },
    ]);
    expect(events).toEqual([
      "recovery:starting",
      "review-history",
      "task-recovery",
      "recovery:completed",
    ]);
  });

  it.each(["shutdown", "deadline", "ownership"])(
    "does not begin task recovery after review reconciliation loses %s authority",
    async (cause) => {
      vi.useFakeTimers();
      let resolveReview: () => void = () => undefined;
      const review = new Promise<void>((resolve) => {
        resolveReview = resolve;
      });
      let owned = true;
      const recoverTasks = vi.fn(async () => undefined);
      const startup = new RuntimeStartup({
        assertOwned: () => {
          if (!owned) throw new Error("Synthetic ownership loss");
        },
        budgets: { recovery: 20 },
      });
      const pending = startup.runSteps("recovery", [() => review, recoverTasks]);
      const rejected = expect(pending).rejects.toThrow();
      await Promise.resolve();
      if (cause === "shutdown") startup.cancel("Synthetic shutdown");
      if (cause === "deadline") await vi.advanceTimersByTimeAsync(20);
      if (cause === "ownership") owned = false;
      resolveReview();
      await rejected;
      await Promise.resolve();
      expect(recoverTasks).not.toHaveBeenCalled();
    },
  );

  it("rechecks execution ownership after an awaited stage", async () => {
    let owned = true;
    const startup = new RuntimeStartup({
      assertOwned: () => {
        if (!owned) throw new Error("Synthetic ownership loss");
      },
    });
    await expect(
      startup.run("native-readiness", async () => {
        owned = false;
      }),
    ).rejects.toThrow("ownership loss");
    expect(startup.signal.aborted).toBe(true);
  });

  it("clips phase work to the remaining total startup budget", async () => {
    vi.useFakeTimers();
    let now = 0;
    const startup = new RuntimeStartup({ assertOwned: () => undefined, now: () => now });
    now = 79_990;
    const pending = startup.run("slack-connection", () => new Promise<void>(() => undefined));
    const rejected = expect(pending).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(startup.signal.aborted).toBe(true);
  });

  it("retains an owned failure receipt when the total deadline expires", async () => {
    let now = 0;
    const states: string[] = [];
    const startup = new RuntimeStartup({
      assertOwned: () => undefined,
      now: () => now,
      onPhase: (event) => {
        if (event.state === "failed") startup.assertFailureReportable();
        states.push(event.state);
      },
    });
    await expect(
      startup.run("native-readiness", async () => {
        now = 80_001;
      }),
    ).rejects.toThrow("total deadline");
    expect(states).toEqual(["starting", "failed"]);
    startup.cancel("Synthetic shutdown");
    expect(() => startup.assertFailureReportable()).toThrow("total deadline");
  });

  it("does not apply the startup deadline to an already ready runtime", () => {
    let now = 0;
    const startup = new RuntimeStartup({ assertOwned: () => undefined, now: () => now });
    startup.complete();
    now = 100_000;
    expect(() => startup.assertRunning()).not.toThrow();
    startup.cancel("Synthetic shutdown");
    expect(() => startup.assertRunning()).toThrow("shutdown");
  });

  it("fails closed on native inspection failure before recovery or Socket Mode", async () => {
    const startup = new RuntimeStartup({ assertOwned: () => undefined });
    await expect(
      startup.run("native-readiness", async () => {
        throw new Error("Synthetic native policy unavailable");
      }),
    ).rejects.toThrow("policy unavailable");
    const recovery = vi.fn(async () => undefined);
    await expect(startup.run("recovery", recovery)).rejects.toThrow("policy unavailable");
    expect(recovery).not.toHaveBeenCalled();
  });

  it("bounds cleanup without claiming an already-issued operation was recalled", async () => {
    vi.useFakeTimers();
    const cleanup = settleStartupCleanup([new Promise<void>(() => undefined)], 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await cleanup).toBe(false);
    expect(await settleStartupCleanup([Promise.resolve()])).toBe(true);
  });
});
