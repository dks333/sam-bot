import { type } from "arktype";

import { activationStartupBudgetMs } from "../runtime/startup-lifecycle.js";
import { parseArk } from "../validation/parse.js";

const healthType = type({
  "agentProvider?": "'codex' | 'claude'",
  pid: "number.integer > 0",
  ready: "boolean",
  releaseId: "string > 0",
  sourceCommit: "string > 0",
  startedAt: "string > 0",
  "stopping?": "boolean",
  "startup?": {
    phase: "string",
    state: "'starting' | 'completed' | 'failed'",
  },
  "nativeReadiness?": {
    status: "string",
    "mode?": "'inherited' | 'subscription'",
    "provider?": "'codex' | 'claude'",
    "version?": "string > 0",
    "authMethod?": "string > 0",
    "subscription?": "string > 0",
    "nativeDefaultsVerified?": "boolean",
    "readOnlySandboxVerified?": "boolean",
    "toolPolicyVerified?": "boolean",
    "modelCatalogueComplete?": "boolean",
  },
});

function nativeReadinessVerified(
  health: typeof healthType.infer,
  provider: "codex" | "claude",
): boolean {
  if ((health.agentProvider ?? "codex") !== provider) return false;
  const readiness = health.nativeReadiness;
  if (readiness?.status !== "native-ready") return false;
  if (provider === "claude") {
    return (
      readiness.mode === "subscription" &&
      readiness.provider === "claude" &&
      readiness.version !== undefined &&
      readiness.authMethod === "claude.ai" &&
      readiness.subscription !== undefined &&
      ["pro", "max", "team", "enterprise"].includes(readiness.subscription.toLowerCase())
    );
  }
  if (readiness.provider !== undefined && readiness.provider !== "codex") return false;
  if (readiness.modelCatalogueComplete !== true) return false;
  return (
    (readiness.mode === "inherited" && readiness.nativeDefaultsVerified === true) ||
    (readiness.mode === undefined &&
      readiness.readOnlySandboxVerified === true &&
      readiness.toolPolicyVerified === true)
  );
}

export function launchedRuntimePid(output: string): number | undefined {
  const match = /^\s*pid = ([1-9]\d*)\s*$/mu.exec(output);
  if (match?.[1] === undefined) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

export async function waitForReleaseReadiness(input: {
  agentProvider?: "codex" | "claude";
  releaseId: string;
  sourceCommit: string;
  startedAfter: string;
  readHealth: () => unknown;
  readPid: () => number | undefined;
  isPidAlive: (pid: number) => boolean;
  wait: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const budget = input.timeoutMs ?? activationStartupBudgetMs;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > activationStartupBudgetMs)
    throw new Error("Activation readiness requires a bounded startup deadline");
  const earliest = Date.parse(input.startedAfter);
  if (!Number.isFinite(earliest)) throw new Error("Activation needs a valid launch timestamp");
  const deadline = now() + budget;
  let lastPhase = "process initialization";
  let observedLaunch: { pid: number; startedAt: string } | undefined;
  while (now() < deadline) {
    let health: typeof healthType.infer | undefined;
    try {
      health = parseArk(healthType, input.readHealth(), "runtime health");
    } catch {
      health = undefined;
    }
    const launchedPid = input.readPid();
    const matchesIdentity =
      health !== undefined &&
      health.releaseId === input.releaseId &&
      health.sourceCommit === input.sourceCommit &&
      Date.parse(health.startedAt) >= earliest &&
      Date.parse(health.startedAt) <= now();
    if (observedLaunch !== undefined) {
      if (launchedPid !== undefined && launchedPid !== observedLaunch.pid)
        throw new Error(
          "The selected runtime process changed during startup; intake remains drained",
        );
      if (
        matchesIdentity &&
        health !== undefined &&
        health.pid === observedLaunch.pid &&
        health.startedAt === observedLaunch.startedAt &&
        health.startup?.state === "failed"
      )
        throw new Error(
          `The selected runtime failed startup phase ${health.startup.phase}; intake remains drained`,
        );
      if (!input.isPidAlive(observedLaunch.pid))
        throw new Error(
          `The selected runtime exited during startup phase ${lastPhase}; intake remains drained`,
        );
    }
    if (
      matchesIdentity &&
      health !== undefined &&
      health.pid === launchedPid &&
      input.isPidAlive(health.pid)
    ) {
      if (observedLaunch !== undefined && health.startedAt !== observedLaunch.startedAt)
        throw new Error(
          "The selected runtime launch changed during startup; intake remains drained",
        );
      observedLaunch = { pid: health.pid, startedAt: health.startedAt };
      if (health.startup !== undefined) {
        lastPhase = health.startup.phase;
        if (health.startup.state === "failed")
          throw new Error(
            `The selected runtime failed startup phase ${lastPhase}; intake remains drained`,
          );
      }
      if (health.stopping === true)
        throw new Error("The selected runtime stopped during startup; intake remains drained");
      if (health.ready && nativeReadinessVerified(health, input.agentProvider ?? "codex")) return;
    }
    await input.wait(Math.min(250, Math.max(1, deadline - now())));
  }
  throw new Error(
    `The selected runtime did not verify ${lastPhase} within its bounded activation deadline; intake remains drained`,
  );
}
