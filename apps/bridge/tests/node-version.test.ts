import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSupportedNodeVersion, isSupportedNodeVersion } from "../src/runtime/node-version.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Node runtime compatibility", () => {
  it.each(["22.14.0", "22.15.0", "22.99.1", "23.6.0", "23.7.0", "24.0.0", "26.12.0"])(
    "accepts Node %s with Node-API 10 support",
    (version) => {
      expect(isSupportedNodeVersion(version)).toBe(true);
      expect(() => assertSupportedNodeVersion(version)).not.toThrow();
    },
  );

  it.each(["20.19.0", "22.0.0", "22.13.0", "22.13.99", "23.0.0", "23.5.99"])(
    "rejects Node %s before native addon loading",
    (version) => {
      expect(isSupportedNodeVersion(version)).toBe(false);
      expect(() => assertSupportedNodeVersion(version)).toThrow("SQLite requires Node-API 10");
    },
  );

  it.each(["", "22.14", "v22.14.0", "022.14.0", "24.0.0-rc.1", "24.0.0-extra", "NaN.14.0"])(
    "rejects malformed or prerelease runtime version %s",
    (version) => {
      expect(isSupportedNodeVersion(version)).toBe(false);
    },
  );

  it.each([
    ["22.13.0", "setup"],
    ["23.5.0", "setup"],
    ["22.13.0", "doctor"],
    ["23.5.0", "doctor"],
    ["22.13.0", "service"],
    ["23.5.0", "agent"],
    ["22.13.0", "run"],
  ])("rejects Node %s in %s before inspecting native state or providers", (version, command) => {
    const directory = mkdtempSync(path.join(tmpdir(), "unsupported-node-"));
    directories.push(directory);
    const preload = path.join(directory, "isolated-runtime.mjs");
    writeFileSync(
      preload,
      `import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });
childProcess.spawnSync = () => { throw new Error("Unexpected synthetic provider invocation"); };
syncBuiltinESMExports();
globalThis.fetch = () => { throw new Error("Unexpected external request"); };
`,
    );
    const filename = path.join(directory, "bridge.sqlite");
    const contents = "Synthetic preserved native state";
    writeFileSync(filename, contents);
    const before = readdirSync(directory).sort();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        command,
      ],
      {
        encoding: "utf8",
        env: { HOME: directory, PATH: process.env.PATH, SLACK_CODEX_HOME: directory },
        timeout: 20_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(`Node ${version} is unsupported`);
    expect(result.stdout + result.stderr).toContain("SQLite requires Node-API 10");
    expect(result.stdout + result.stderr).not.toContain("Unexpected");
    expect(result.stdout).not.toContain("SQLite:");
    expect(readFileSync(filename, "utf8")).toBe(contents);
    expect(readdirSync(directory).sort()).toEqual(before);
  });
});
