export interface SlackConnectionState {
  state: "connecting" | "connected" | "reconnecting" | "disconnected" | "stopping" | "stopped";
  connected: boolean;
  attempt: number;
  reason?: "transport" | "timeout";
  observedAt: string;
}

export interface SlackConnectionTransport {
  connect(signal: AbortSignal): Promise<unknown>;
  disconnect(): Promise<unknown>;
  subscribe(
    event: "authenticated" | "connected" | "close" | "disconnected" | "error",
    listener: () => void,
  ): () => void;
}

export interface SlackConnectionLifecycleOptions {
  transport: SlackConnectionTransport;
  onChanged?: (state: SlackConnectionState) => void | Promise<void>;
  connectTimeoutMs?: number;
  startupTimeoutMs?: number;
  retryInitialMs?: number;
  retryMaximumMs?: number;
  stopTimeoutMs?: number;
  now?: () => Date;
}

interface ConnectionAttempt {
  generation: number;
  controller: AbortController;
  authenticated: boolean;
  hello: boolean;
  closed: boolean;
  reason?: SlackConnectionState["reason"];
  deadline?: ReturnType<typeof setTimeout>;
  changed: Promise<void>;
  notify: () => void;
}

interface ReadyWaiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function duration(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error("Slack connection timing is outside its supported bounds");
  return value;
}

function stoppedError(): Error {
  return new Error("Slack connection lifecycle is stopped");
}

async function withAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? stoppedError());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

export function slackRequestFetch(options: {
  signal: () => AbortSignal;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const timeoutMs = duration(options.timeoutMs, 30_000);
  const request = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const signals = [options.signal(), AbortSignal.timeout(timeoutMs)];
    if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
    if (input instanceof Request) signals.push(input.signal);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const response = await request(input, { ...init, signal });
    signal.throwIfAborted();
    return response;
  };
}

export class SlackConnectionLifecycle {
  readonly #transport: SlackConnectionTransport;
  readonly #onChanged: SlackConnectionLifecycleOptions["onChanged"];
  readonly #now: () => Date;
  readonly #connectTimeoutMs: number;
  readonly #startupTimeoutMs: number;
  readonly #retryInitialMs: number;
  readonly #retryMaximumMs: number;
  readonly #stopTimeoutMs: number;
  readonly #controller = new AbortController();
  readonly #waiters = new Set<ReadyWaiter>();
  readonly #unsubscribe: (() => void)[];
  #loop: Promise<void> | undefined;
  #stop: Promise<void> | undefined;
  #attempt: ConnectionAttempt | undefined;
  #generation = 0;
  #attemptNumber = 0;
  #connected = false;
  #everConnected = false;
  #response: unknown;
  #lastState: SlackConnectionState["state"] | undefined;
  #lastReason: SlackConnectionState["reason"];

  constructor(options: SlackConnectionLifecycleOptions) {
    this.#transport = options.transport;
    this.#onChanged = options.onChanged;
    this.#now = options.now ?? (() => new Date());
    this.#connectTimeoutMs = duration(options.connectTimeoutMs ?? 5_000, 30_000);
    this.#startupTimeoutMs = duration(options.startupTimeoutMs ?? 15_000, 60_000);
    this.#retryInitialMs = duration(options.retryInitialMs ?? 1_000, 30_000);
    this.#retryMaximumMs = duration(options.retryMaximumMs ?? 30_000, 60_000);
    this.#stopTimeoutMs = duration(options.stopTimeoutMs ?? 1_000, 5_000);
    if (this.#retryMaximumMs < this.#retryInitialMs)
      throw new Error("Slack retry maximum must cover its initial delay");
    this.#unsubscribe = [
      this.#transport.subscribe("authenticated", () => {
        const attempt = this.#attempt;
        if (attempt !== undefined && this.#current(attempt)) attempt.authenticated = true;
      }),
      this.#transport.subscribe("connected", () => this.#hello()),
      this.#transport.subscribe("close", () => this.#closed()),
      this.#transport.subscribe("disconnected", () => this.#closed()),
      this.#transport.subscribe("error", () => this.#transportError()),
    ];
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  start(): Promise<unknown> {
    if (this.signal.aborted) return Promise.reject(stoppedError());
    if (this.#connected) return Promise.resolve(this.#response);
    const ready = new Promise<unknown>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("Slack connection startup exceeded its deadline"));
          if (!this.#everConnected) void this.stop();
        }, this.#startupTimeoutMs),
      };
      this.#waiters.add(waiter);
    });
    if (this.#loop === undefined) {
      this.#loop = this.#run();
      void this.#loop.catch(() => {
        this.#publish("disconnected", "transport");
        this.#rejectWaiters(new Error("Slack connection supervision failed"));
      });
    }
    return ready;
  }

  stop(): Promise<void> {
    if (this.#stop !== undefined) return this.#stop;
    this.#generation += 1;
    this.#controller.abort(stoppedError());
    if (this.#attempt?.deadline !== undefined) clearTimeout(this.#attempt.deadline);
    this.#attempt?.controller.abort(stoppedError());
    this.#attempt?.notify();
    this.#connected = false;
    this.#publish("stopping");
    this.#rejectWaiters(stoppedError());
    this.#stop = this.#stopTransport();
    return this.#stop;
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.signal.aborted) {
      this.#generation += 1;
      let notify = () => {};
      const changed = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const attempt: ConnectionAttempt = {
        generation: this.#generation,
        controller: new AbortController(),
        authenticated: false,
        hello: false,
        closed: false,
        changed,
        notify,
      };
      this.#attempt = attempt;
      this.#attemptNumber += 1;
      this.#publish(this.#everConnected || this.#attemptNumber > 1 ? "reconnecting" : "connecting");
      const deadline = setTimeout(() => {
        if (!this.#current(attempt)) return;
        attempt.reason = "timeout";
        attempt.controller.abort(new Error("Slack connection attempt timed out"));
        attempt.notify();
        void this.#disconnect().catch(() => undefined);
      }, this.#connectTimeoutMs);
      attempt.deadline = deadline;
      const signal = AbortSignal.any([this.signal, attempt.controller.signal]);
      try {
        const response = await this.#transport.connect(signal);
        if (!this.#current(attempt)) {
          void this.#disconnect().catch(() => undefined);
          break;
        }
        if (!attempt.hello && !attempt.closed) await withAbort(attempt.changed, signal);
        if (attempt.closed || !attempt.hello || signal.aborted)
          throw new Error("Slack connection did not complete its hello handshake");
        clearTimeout(deadline);
        this.#connected = true;
        this.#everConnected = true;
        this.#response = response;
        failures = 0;
        this.#publish("connected");
        for (const waiter of this.#waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(response);
        }
        this.#waiters.clear();
        await this.#waitForClose(attempt, signal);
      } catch {
        if (!this.signal.aborted) {
          this.#connected = false;
          this.#publish("disconnected", attempt.reason ?? "transport");
        }
      } finally {
        clearTimeout(deadline);
        if (this.#attempt === attempt) this.#attempt = undefined;
      }
      if (this.signal.aborted) break;
      if (attempt.authenticated && !attempt.closed) {
        try {
          await withAbort(this.#disconnect(), this.signal);
        } catch {
          break;
        }
      }
      failures += 1;
      const delay = Math.min(
        this.#retryMaximumMs,
        this.#retryInitialMs * 2 ** Math.min(failures - 1, 16),
      );
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await withAbort(
          new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, delay);
          }),
          this.signal,
        );
      } catch {
        break;
      } finally {
        if (retryTimer !== undefined) clearTimeout(retryTimer);
      }
    }
  }

  #current(attempt: ConnectionAttempt): boolean {
    return (
      !this.signal.aborted && this.#attempt === attempt && this.#generation === attempt.generation
    );
  }

  #hello(): void {
    const attempt = this.#attempt;
    if (attempt === undefined || !this.#current(attempt) || attempt.controller.signal.aborted) {
      void this.#disconnect().catch(() => undefined);
      return;
    }
    attempt.hello = true;
    attempt.notify();
  }

  #closed(): void {
    const attempt = this.#attempt;
    this.#connected = false;
    if (attempt !== undefined) {
      attempt.closed = true;
      attempt.reason ??= "transport";
      attempt.controller.abort(new Error("Slack transport disconnected"));
      attempt.notify();
    }
    if (!this.signal.aborted) this.#publish("disconnected", attempt?.reason ?? "transport");
  }

  #transportError(): void {
    this.#connected = false;
    const attempt = this.#attempt;
    if (attempt !== undefined) {
      attempt.reason = "transport";
      attempt.controller.abort(new Error("Slack transport failed"));
      attempt.notify();
    }
    if (!this.signal.aborted) this.#publish("disconnected", "transport");
    void this.#disconnect().catch(() => undefined);
  }

  async #waitForClose(attempt: ConnectionAttempt, signal: AbortSignal): Promise<void> {
    if (attempt.closed || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      const finish = () => {
        unsubscribe();
        signal.removeEventListener("abort", finish);
        resolve();
      };
      unsubscribe = this.#transport.subscribe("close", finish);
      signal.addEventListener("abort", finish, { once: true });
      if (attempt.closed || signal.aborted) finish();
    });
  }

  async #disconnect(): Promise<void> {
    await this.#transport.disconnect();
  }

  async #stopTransport(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    const disconnected = this.#disconnect().then(
      () => {
        completed = true;
      },
      () => undefined,
    );
    await Promise.race([
      disconnected,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#stopTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (completed) this.#publish("stopped");
    void disconnected
      .then(() => {
        if (completed) this.#publish("stopped");
        for (const unsubscribe of this.#unsubscribe) unsubscribe();
      })
      .catch(() => undefined);
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  #publish(state: SlackConnectionState["state"], reason?: SlackConnectionState["reason"]): void {
    if (this.signal.aborted && state !== "stopping" && state !== "stopped") return;
    if (
      this.#lastState === state &&
      this.#lastReason === reason &&
      state !== "connecting" &&
      state !== "reconnecting"
    )
      return;
    this.#lastState = state;
    this.#lastReason = reason;
    try {
      const event: SlackConnectionState = {
        state,
        connected: state === "connected",
        attempt: this.#attemptNumber,
        observedAt: this.#now().toISOString(),
        ...(reason === undefined ? {} : { reason }),
      };
      const pending = this.#onChanged?.(event);
      if (pending !== undefined) void pending.catch(() => undefined);
    } catch {
      return;
    }
  }
}
