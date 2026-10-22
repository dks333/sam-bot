export type StartupPhase =
  | "control-plane"
  | "native-initialization"
  | "native-readiness"
  | "recovery"
  | "slack-connection";

export const startupPhaseBudgets: Record<StartupPhase, number> = {
  "control-plane": 10_000,
  "native-initialization": 15_000,
  "native-readiness": 15_000,
  recovery: 30_000,
  "slack-connection": 15_000,
};

export const activationStartupBudgetMs = 90_000;
export const runtimeStartupBudgetMs = 80_000;

export async function settleStartupCleanup(
  operations: Promise<unknown>[],
  timeoutMs = 8_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface StartupPhaseEvent {
  phase: StartupPhase;
  state: "starting" | "completed" | "failed";
  elapsedMs: number;
}

export function registerStartupSignals(
  source: { once: (signal: string, handler: () => void) => unknown },
  startup: RuntimeStartup,
  resolveShutdown: () => ((signal: string) => Promise<void>) | undefined,
): void {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    source.once(signal, () => {
      const shutdown = resolveShutdown();
      if (shutdown === undefined) startup.cancel(`Runtime startup stopped by ${signal}`);
      else void shutdown(signal);
    });
  }
}

export class RuntimeStartup {
  readonly #controller = new AbortController();
  readonly #assertOwned: () => void;
  readonly #onPhase: (event: StartupPhaseEvent) => void;
  readonly #budgets: Record<StartupPhase, number>;
  readonly #now: () => number;
  readonly #deadline: number;
  #cancelled = false;
  #completed = false;

  constructor(options: {
    assertOwned: () => void;
    onPhase?: (event: StartupPhaseEvent) => void;
    budgets?: Partial<Record<StartupPhase, number>>;
    now?: () => number;
  }) {
    this.#assertOwned = options.assertOwned;
    this.#onPhase = options.onPhase ?? (() => undefined);
    this.#budgets = { ...startupPhaseBudgets, ...options.budgets };
    this.#now = options.now ?? (() => performance.now());
    this.#deadline = this.#now() + runtimeStartupBudgetMs;
    for (const budget of Object.values(this.#budgets)) {
      if (!Number.isSafeInteger(budget) || budget < 1 || budget > activationStartupBudgetMs)
        throw new Error("Startup phases require bounded positive deadlines");
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  cancel(reason = "Runtime startup was cancelled"): void {
    this.#cancelled = true;
    this.#controller.abort(new Error(reason));
  }

  complete(): void {
    this.assertRunning();
    this.#completed = true;
  }

  assertFailureReportable(): void {
    if (this.#cancelled) this.signal.throwIfAborted();
    this.#assertOwned();
  }

  assertRunning(): void {
    this.signal.throwIfAborted();
    if (!this.#completed && this.#now() >= this.#deadline) {
      this.#controller.abort(new Error("Runtime startup exceeded its total deadline"));
      this.signal.throwIfAborted();
    }
    this.#assertOwned();
  }

  async runSteps(
    phase: StartupPhase,
    operations: readonly ((signal: AbortSignal) => Promise<unknown>)[],
  ): Promise<void> {
    await this.run(phase, async (signal) => {
      for (const operation of operations) {
        signal.throwIfAborted();
        this.assertRunning();
        await operation(signal);
      }
    });
  }

  async run<T>(
    phase: StartupPhase,
    operation: (signal: AbortSignal) => Promise<T>,
    closeLateResult?: (result: T) => Promise<void>,
  ): Promise<T> {
    if (this.#completed) throw new Error("Runtime startup is already complete");
    this.assertRunning();
    const began = this.#now();
    this.#onPhase({ phase, state: "starting", elapsedMs: 0 });
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(`Startup phase ${phase} exceeded its deadline`)),
      Math.min(this.#budgets[phase], this.#deadline - this.#now()),
    );
    const signal = AbortSignal.any([this.signal, deadline.signal]);
    let onAbort: (() => void) | undefined;
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      this.assertRunning();
      return operation(signal);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Runtime startup was cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([pending, aborted]);
      signal.throwIfAborted();
      this.assertRunning();
      this.#onPhase({ phase, state: "completed", elapsedMs: this.#now() - began });
      return result;
    } catch (error) {
      if (closeLateResult !== undefined) void pending.then(closeLateResult).catch(() => undefined);
      if (!this.#cancelled)
        this.#onPhase({ phase, state: "failed", elapsedMs: this.#now() - began });
      this.#controller.abort(error);
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }
}
