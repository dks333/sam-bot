import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReleaseManifest, sha256 } from "../src/cli/release-manager.js";
import { defaultProductConfig } from "../src/config/product.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function fixture(provider: "codex" | "claude", managedRelease: boolean) {
  const directory = mkdtempSync(path.join(tmpdir(), "cli-service-agent-"));
  directories.push(directory);
  const config = defaultProductConfig(directory);
  writeFileSync(
    path.join(directory, "config.json"),
    JSON.stringify({ ...config, runtime: { ...config.runtime, agentProvider: provider } }),
    { mode: 0o600 },
  );
  if (managedRelease) {
    const release = path.join(directory, "releases", "synthetic-codex-only");
    mkdirSync(path.join(release, "dist"), { recursive: true });
    writeFileSync(path.join(release, "dist", "index.js"), "export const synthetic = true;\n");
    writeFileSync(
      path.join(release, "package.json"),
      JSON.stringify({
        dependencies: { "@openai/codex": "0.162.1", "@openai/codex-sdk": "0.162.1" },
      }),
    );
    const lockfile = "synthetic lockfile\n";
    writeFileSync(path.join(release, "source-lock.yaml"), lockfile);
    createReleaseManifest({
      directory: release,
      codexVersion: "0.162.1",
      createdAt: "2026-10-22T12:00:00.000Z",
      maximumSchemaVersion: 11,
      maximumNativeSchemaVersion: 1,
      packageManager: "pnpm@11.9.0",
      policyVersion: "task-controller-v1",
      releaseId: "synthetic-codex-only",
      sourceClean: true,
      sourceCommit: "a".repeat(40),
      sourceLockHash: sha256(lockfile),
    });
    symlinkSync(release, path.join(directory, "runtime-current"));
  }
  const calls = path.join(directory, "launchctl-calls.jsonl");
  writeFileSync(calls, "");
  const preload = path.join(directory, "isolated-launchctl.mjs");
  writeFileSync(
    preload,
    `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawnSync = (executable, arguments_) => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ executable, arguments_ }) + "\\n");
  return { status: 0, stdout: "synthetic service", stderr: "" };
};
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("External requests are forbidden in this fixture"); };
`,
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        "service",
        "start",
      ],
      {
        encoding: "utf8",
        env: { HOME: directory, PATH: process.env.PATH, SLACK_CODEX_HOME: directory },
        timeout: 20_000,
      },
    );
  return { calls, run };
}

describe("service agent compatibility", () => {
  it.each([true, false])(
    "refuses unsupported Claude service start before launchctl (managed release: %s)",
    (managedRelease) => {
      const { calls, run } = fixture("claude", managedRelease);
      const result = run();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      if (managedRelease)
        expect(result.stderr).toContain("does not support the configured claude agent");
      else expect(result.stderr).toContain("Activate a managed release supporting Claude");
      expect(readFileSync(calls, "utf8")).toBe("");
    },
    30_000,
  );

  it("preserves the legacy Codex service start path", () => {
    const { calls, run } = fixture("codex", false);
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain('"kickstart"');
  }, 30_000);
});
