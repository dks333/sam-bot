export interface NativeStartupEvent {
  stage: "hook-bridge" | "process-launch" | "initialize-rpc";
  state: "starting" | "completed" | "failed";
  elapsedMs: number;
}

export function observeNativeStartup(
  observer: ((event: NativeStartupEvent) => void) | undefined,
  stage: NativeStartupEvent["stage"],
  state: NativeStartupEvent["state"],
  began: number,
): void {
  const elapsedMs = Math.max(0, Math.min(90_000, performance.now() - began));
  try {
    observer?.({ stage, state, elapsedMs });
  } catch {}
}
