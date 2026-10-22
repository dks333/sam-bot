import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SlackConnectionLifecycle,
  slackRequestFetch,
  type SlackConnectionState,
  type SlackConnectionTransport,
} from "../src/slack/connection-lifecycle.js";

interface PendingConnect {
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class FakeTransport implements SlackConnectionTransport {
  readonly events = new EventEmitter();
  readonly attempts: PendingConnect[] = [];
  cooperateWithAbort = true;
  holdDisconnect = false;
  disconnectCount = 0;

  connect(signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.attempts.push({ signal, resolve, reject });
      if (this.cooperateWithAbort)
        signal.addEventListener("abort", () => reject(new Error("Synthetic connection aborted")), {
          once: true,
        });
    });
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    if (this.holdDisconnect) await new Promise<void>(() => {});
    this.events.emit("close");
    this.events.emit("disconnected");
  }

  subscribe(
    event: "authenticated" | "connected" | "close" | "disconnected" | "error",
    listener: () => void,
  ): () => void {
    this.events.on(event, listener);
    return () => {
      this.events.removeListener(event, listener);
    };
  }

  pending(index = this.attempts.length - 1): PendingConnect {
    const pending = this.attempts[index];
    if (pending === undefined) throw new Error("Expected an active synthetic connection attempt");
    return pending;
  }

  hello(value: unknown = { synthetic: true }): void {
    this.events.emit("authenticated");
    this.events.emit("connected");
    this.pending().resolve(value);
  }
}

const lifecycles: SlackConnectionLifecycle[] = [];

function fixture(
  options: {
    cooperate?: boolean;
    onChanged?: (state: SlackConnectionState) => void | Promise<void>;
  } = {},
) {
  const transport = new FakeTransport();
  transport.cooperateWithAbort = options.cooperate !== false;
  const states: SlackConnectionState[] = [];
  const lifecycle = new SlackConnectionLifecycle({
    transport,
    connectTimeoutMs: 500,
    startupTimeoutMs: 10_000,
    retryInitialMs: 100,
    retryMaximumMs: 400,
    stopTimeoutMs: 100,
    onChanged: (state) => {
      states.push(state);
      return options.onChanged?.(state);
    },
  });
  lifecycles.push(lifecycle);
  return { transport, states, lifecycle };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const stopping = lifecycles.splice(0).map((lifecycle) => lifecycle.stop());
  await vi.advanceTimersByTimeAsync(101);
  await Promise.all(stopping);
  vi.useRealTimers();
});

describe("supervised Slack connection lifecycle", () => {
  it("requires an actual hello event before promoting connection health", async () => {
    const value = fixture();
    const ready = value.lifecycle.start();
    value.transport.events.emit("authenticated");
    value.transport.pending().resolve({ synthetic: "response" });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.states.some((state) => state.connected)).toBe(false);
    value.transport.events.emit("connected");
    await expect(ready).resolves.toEqual({ synthetic: "response" });
    expect(value.states.at(-1)).toMatchObject({ state: "connected", connected: true, attempt: 1 });
  });

  it("catches repeated network failures and retries one connection at bounded backoff", async () => {
    const value = fixture();
    const ready = value.lifecycle.start().catch((error: unknown) => error);
    for (const { index, delay } of [
      { index: 0, delay: 100 },
      { index: 1, delay: 200 },
      { index: 2, delay: 400 },
      { index: 3, delay: 400 },
    ]) {
      value.transport.pending(index).reject(new Error("Synthetic network failure"));
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(value.transport.attempts).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(value.transport.attempts).toHaveLength(index + 2);
    }
    value.transport.hello();
    await expect(ready).resolves.toEqual({ synthetic: true });
    expect(value.states.at(-1)?.connected).toBe(true);
    expect(value.states.filter((state) => state.state === "reconnecting")).toHaveLength(4);
  });

  it("coalesces duplicate disconnect events and concurrent starts into one reconnect", async () => {
    const value = fixture();
    const initial = value.lifecycle.start();
    value.transport.hello();
    await initial;
    value.transport.events.emit("close");
    value.transport.events.emit("close");
    value.transport.events.emit("disconnected");
    expect(value.states.at(-1)?.connected).toBe(false);
    const first = value.lifecycle.start();
    const second = value.lifecycle.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(value.transport.attempts).toHaveLength(2);
    value.transport.hello({ synthetic: "recovered" });
    await expect(first).resolves.toEqual({ synthetic: "recovered" });
    await expect(second).resolves.toEqual({ synthetic: "recovered" });
    expect(value.transport.attempts).toHaveLength(2);
  });

  it.each(["disconnected", "error"])(
    "reconnects after %s without requiring a close event",
    async (event) => {
      const value = fixture();
      const ready = value.lifecycle.start();
      value.transport.hello();
      await ready;
      value.transport.events.emit(event);
      expect(value.states.at(-1)?.connected).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(value.transport.attempts).toHaveLength(2);
      expect(value.transport.events.listenerCount("close")).toBe(1);
      value.transport.hello();
      await vi.advanceTimersByTimeAsync(0);
      expect(value.states.at(-1)?.connected).toBe(true);
    },
  );

  it("fences stop during an uncooperative start and never promotes its late result", async () => {
    const value = fixture({ cooperate: false });
    const ready = value.lifecycle.start().catch((error: unknown) => error);
    await value.lifecycle.stop();
    expect(await ready).toBeInstanceOf(Error);
    value.transport.hello({ synthetic: "late" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(value.transport.attempts).toHaveLength(1);
    expect(value.states.some((state) => state.connected)).toBe(false);
    await expect(value.lifecycle.start()).rejects.toThrow("stopped");
  });

  it("stops retrying during backoff and cancels startup waiters", async () => {
    const value = fixture();
    const ready = value.lifecycle.start().catch((error: unknown) => error);
    value.transport.pending().reject(new Error("Synthetic network failure"));
    await vi.advanceTimersByTimeAsync(50);
    await value.lifecycle.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await ready).toBeInstanceOf(Error);
    expect(value.transport.attempts).toHaveLength(1);
    expect(value.states.at(-1)).toMatchObject({ state: "stopped", connected: false });
  });

  it("times out a connecting attempt without reporting a fabricated connection", async () => {
    const value = fixture();
    const ready = value.lifecycle.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(value.transport.pending(0).signal.aborted).toBe(true);
    expect(value.states.at(-1)).toMatchObject({
      state: "disconnected",
      connected: false,
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(value.transport.attempts).toHaveLength(2);
    value.transport.hello();
    await expect(ready).resolves.toEqual({ synthetic: true });
  });

  it("does not start a replacement while an aborted connection remains unresolved", async () => {
    const value = fixture({ cooperate: false });
    const ready = value.lifecycle.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(value.transport.attempts).toHaveLength(1);
    value.transport.pending(0).reject(new Error("Synthetic late abort confirmation"));
    await vi.advanceTimersByTimeAsync(100);
    expect(value.transport.attempts).toHaveLength(2);
    value.transport.hello();
    await expect(ready).resolves.toEqual({ synthetic: true });
  });

  it("contains synchronous and asynchronous connection observers without exposing payloads", async () => {
    for (const asynchronous of [false, true]) {
      const value = fixture({
        onChanged: () => {
          if (asynchronous) return Promise.reject(new Error("Synthetic observer failure"));
          throw new Error("Synthetic observer failure");
        },
      });
      const ready = value.lifecycle.start();
      value.transport.hello({ url: "wss://example.com/private-connection" });
      await ready;
      expect(value.states.at(-1)?.connected).toBe(true);
      expect(JSON.stringify(value.states)).not.toContain("private-connection");
    }
  });

  it("returns bounded stop while retaining an unconfirmed stopping state", async () => {
    const value = fixture();
    const ready = value.lifecycle.start();
    value.transport.hello();
    await ready;
    value.transport.holdDisconnect = true;
    const stop = value.lifecycle.stop();
    await vi.advanceTimersByTimeAsync(100);
    await stop;
    expect(value.states.at(-1)).toMatchObject({ state: "stopping", connected: false });
    expect(value.states.some((state) => state.state === "stopped")).toBe(false);
  });

  it("rejects a late HTTP result and refuses later requests after the lifetime ends", async () => {
    const controller = new AbortController();
    let release = (_response: Response) => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending);
    const request = slackRequestFetch({ signal: () => controller.signal, timeoutMs: 500, fetch });
    const response = request("https://example.com/synthetic-api").catch((error: unknown) => error);
    controller.abort(new Error("Synthetic shutdown"));
    release(new Response("{}"));
    expect(await response).toBeInstanceOf(Error);
    await expect(request("https://example.com/synthetic-api")).rejects.toThrow(
      "Synthetic shutdown",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});
