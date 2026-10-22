import { describe, expect, it } from "vitest";

import { launchedRuntimePid, waitForReleaseReadiness } from "../src/cli/release-readiness.js";

const began = Date.parse("2026-10-15T00:00:00.000Z");

function health() {
  return {
    pid: 123,
    releaseId: "synthetic-release",
    sourceCommit: "a".repeat(40),
    ready: true,
    startedAt: new Date(began).toISOString(),
    nativeReadiness: {
      status: "native-ready",
      readOnlySandboxVerified: true,
      toolPolicyVerified: true,
      modelCatalogueComplete: true,
    },
  };
}

function claudeHealth() {
  return {
    ...health(),
    agentProvider: "claude",
    nativeReadiness: {
      status: "native-ready",
      mode: "subscription",
      provider: "claude",
      version: "2.1.306 (Claude Code)",
      authMethod: "claude.ai",
      subscription: "max",
    },
  };
}

function observer(
  readHealth: () => unknown,
  readPid: () => number | undefined = () => 123,
  isPidAlive = () => true,
) {
  let now = began;
  return {
    input: {
      releaseId: "synthetic-release",
      sourceCommit: "a".repeat(40),
      startedAfter: new Date(began).toISOString(),
      readHealth,
      readPid,
      isPidAlive,
      now: () => now,
      wait: async (milliseconds: number) => {
        now += milliseconds;
      },
      timeoutMs: 30_000,
    },
    elapsed: () => now - began,
  };
}

describe("activation startup readiness", () => {
  it("accepts the selected Claude subscription without requiring a Codex model catalogue", async () => {
    const fixture = observer(claudeHealth);
    await expect(
      waitForReleaseReadiness({ ...fixture.input, agentProvider: "claude" }),
    ).resolves.toBeUndefined();
    expect(fixture.elapsed()).toBe(0);
  });

  it.each([
    { label: "Codex health", value: health() },
    { label: "unready transport", value: { ...claudeHealth(), ready: false } },
    { label: "missing outer provider", value: { ...claudeHealth(), agentProvider: undefined } },
    { label: "wrong PID", value: { ...claudeHealth(), pid: 456 } },
    ...[
      { label: "unavailable subscription", fields: { status: "unavailable" } },
      { label: "inherited mode", fields: { mode: "inherited" } },
      { label: "wrong native provider", fields: { provider: "codex" } },
      { label: "missing native provider", fields: { provider: undefined } },
      { label: "missing CLI version", fields: { version: undefined } },
      { label: "blank CLI version", fields: { version: "" } },
      { label: "API authentication", fields: { authMethod: "api_key" } },
      { label: "missing authentication", fields: { authMethod: undefined } },
      { label: "missing subscription", fields: { subscription: undefined } },
      { label: "unsupported account", fields: { subscription: "free" } },
    ].map(({ label, fields }) => ({
      label,
      value: {
        ...claudeHealth(),
        nativeReadiness: { ...claudeHealth().nativeReadiness, ...fields },
      },
    })),
  ])("rejects Claude activation with $label", async ({ value }) => {
    const fixture = observer(() => value);
    await expect(
      waitForReleaseReadiness({ ...fixture.input, agentProvider: "claude" }),
    ).rejects.toThrow("bounded activation deadline");
  });

  it("does not accept Claude health when the selected provider defaults to Codex", async () => {
    const fixture = observer(claudeHealth);
    await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow("deadline");
  });

  it.each(["inherited", undefined])(
    "still rejects Codex mode %s without a complete model catalogue",
    async (mode) => {
      const fixture = observer(() => ({
        ...health(),
        nativeReadiness: {
          ...health().nativeReadiness,
          mode,
          nativeDefaultsVerified: true,
          modelCatalogueComplete: undefined,
        },
      }));
      await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow("deadline");
    },
  );

  it("reports Claude startup failures before subscription evidence is available", async () => {
    const { nativeReadiness: _nativeReadiness, ...initialHealth } = claudeHealth();
    const fixture = observer(() => ({
      ...initialHealth,
      ready: false,
      startup: { phase: "native-initialization", state: "failed" },
    }));
    await expect(
      waitForReleaseReadiness({ ...fixture.input, agentProvider: "claude" }),
    ).rejects.toThrow("failed startup phase native-initialization");
    expect(fixture.elapsed()).toBe(0);
  });

  it("accepts verified inherited native defaults without claiming a read-only tool policy", async () => {
    const fixture = observer(() => ({
      ...health(),
      nativeReadiness: {
        status: "native-ready",
        mode: "inherited",
        nativeDefaultsVerified: true,
        modelCatalogueComplete: true,
      },
    }));
    await expect(waitForReleaseReadiness(fixture.input)).resolves.toBeUndefined();
  });

  it.each([false, undefined])(
    "rejects inherited mode without verified defaults: %s",
    async (verified) => {
      const fixture = observer(() => ({
        ...health(),
        nativeReadiness: {
          ...health().nativeReadiness,
          mode: "inherited",
          nativeDefaultsVerified: verified,
        },
      }));
      await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow("deadline");
    },
  );

  it("accepts a cold startup beyond twenty seconds only after native and transport readiness", async () => {
    const fixture = observer(() => ({
      ...health(),
      ready: fixture.elapsed() >= 25_000,
      startup: { phase: "native-readiness", state: "starting" },
    }));
    await waitForReleaseReadiness(fixture.input);
    expect(fixture.elapsed()).toBe(25_000);
  });

  it.each([
    { label: "wrong release", value: { ...health(), releaseId: "another-release" } },
    { label: "wrong source", value: { ...health(), sourceCommit: "b".repeat(40) } },
    { label: "wrong PID", value: { ...health(), pid: 456 } },
    { label: "stale launch", value: { ...health(), startedAt: new Date(began - 1).toISOString() } },
    {
      label: "future launch",
      value: { ...health(), startedAt: new Date(began + 60_000).toISOString() },
    },
    { label: "socket only", value: { ...health(), nativeReadiness: undefined } },
    {
      label: "unavailable native",
      value: {
        ...health(),
        nativeReadiness: { ...health().nativeReadiness, status: "unavailable" },
      },
    },
    {
      label: "unverified tools",
      value: {
        ...health(),
        nativeReadiness: { ...health().nativeReadiness, toolPolicyVerified: false },
      },
    },
    {
      label: "incomplete catalogue",
      value: {
        ...health(),
        nativeReadiness: { ...health().nativeReadiness, modelCatalogueComplete: false },
      },
    },
  ])("rejects $label evidence without declaring activation", async ({ value }) => {
    const fixture = observer(() => value);
    await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow(
      "bounded activation deadline",
    );
    expect(fixture.elapsed()).toBe(30_000);
  });

  it("rejects an exited PID and a PID outside the launchd job", async () => {
    await expect(
      waitForReleaseReadiness(
        observer(
          health,
          () => 123,
          () => false,
        ).input,
      ),
    ).rejects.toThrow("deadline");
    await expect(waitForReleaseReadiness(observer(health, () => undefined).input)).rejects.toThrow(
      "deadline",
    );
  });

  it("reports an explicit owned startup phase failure immediately and preserves drain", async () => {
    const fixture = observer(() => ({
      ...health(),
      ready: false,
      startup: { phase: "native-readiness", state: "failed" },
    }));
    await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow(
      "failed startup phase native-readiness; intake remains drained",
    );
    expect(fixture.elapsed()).toBe(0);
  });

  it("reports the observed launch's final failure after its process has exited", async () => {
    const fixture = observer(
      () => ({
        ...health(),
        ready: false,
        startup: {
          phase: "native-initialization",
          state: fixture.elapsed() === 0 ? "starting" : "failed",
        },
      }),
      () => (fixture.elapsed() === 0 ? 123 : undefined),
      () => fixture.elapsed() === 0,
    );
    await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow(
      "failed startup phase native-initialization",
    );
    expect(fixture.elapsed()).toBe(250);
  });

  it("fails promptly if the observed startup process exits without final health", async () => {
    const fixture = observer(
      () => ({
        ...health(),
        ready: false,
        startup: { phase: "native-initialization", state: "starting" },
      }),
      () => undefined,
      () => fixture.elapsed() === 0,
    );
    let reads = 0;
    const input = {
      ...fixture.input,
      readPid: () => {
        reads += 1;
        return reads === 1 ? 123 : undefined;
      },
    };
    await expect(waitForReleaseReadiness(input)).rejects.toThrow(
      "exited during startup phase native-initialization",
    );
    expect(fixture.elapsed()).toBe(250);
  });

  it.each(["wrong source", "old timestamp", "different PID"])(
    "does not attribute %s terminal health to a previously observed launch",
    async (variation) => {
      const fixture = observer(() => {
        const first = fixture.elapsed() === 0;
        const current = {
          ...health(),
          ready: false,
          startup: { phase: "native-initialization", state: "starting" },
        };
        if (first) return current;
        current.startup.state = "failed";
        if (variation === "wrong source") current.sourceCommit = "b".repeat(40);
        if (variation === "old timestamp") current.startedAt = new Date(began - 1).toISOString();
        if (variation === "different PID") current.pid = 456;
        return current;
      });
      await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow("deadline");
      expect(fixture.elapsed()).toBe(30_000);
    },
  );

  it.each(["different PID", "reused PID"])(
    "does not accept ready health from a replacement launch with %s",
    async (variation) => {
      const fixture = observer(
        () => {
          const first = fixture.elapsed() === 0;
          const current = { ...health(), ready: !first };
          if (first) return current;
          if (variation === "different PID") current.pid = 456;
          else current.startedAt = new Date(began + 1).toISOString();
          return current;
        },
        () => (fixture.elapsed() === 0 || variation === "reused PID" ? 123 : 456),
      );
      await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow(
        "changed during startup",
      );
      expect(fixture.elapsed()).toBe(250);
    },
  );

  it("rejects shutdown health even while the exact previously ready PID is still alive", async () => {
    const fixture = observer(() => ({ ...health(), ready: false, stopping: true }));
    await expect(waitForReleaseReadiness(fixture.input)).rejects.toThrow(
      "stopped during startup; intake remains drained",
    );
    expect(fixture.elapsed()).toBe(0);
  });

  it("parses only an actual launchctl job PID", () => {
    expect(launchedRuntimePid("\tpid = 123\n\tlast exit code = 0\n")).toBe(123);
    expect(launchedRuntimePid("last pid = 123\npid = 0\n")).toBeUndefined();
  });
});
