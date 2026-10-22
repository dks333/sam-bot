import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultProductConfig, productConfigType } from "../src/config/product.js";
import { parseArk } from "../src/validation/parse.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "cli-agent-"));
  directories.push(directory);
  const config = defaultProductConfig(directory);
  const configFile = path.join(directory, "config.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const ledger = path.join(directory, "native-conversations.sqlite");
  writeFileSync(ledger, "synthetic-existing-ledger", { mode: 0o600 });
  const run = (arguments_: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        "agent",
        ...arguments_,
      ],
      {
        encoding: "utf8",
        env: { HOME: directory, PATH: process.env.PATH, SLACK_CODEX_HOME: directory },
        timeout: 20_000,
      },
    );
  const readConfig = () =>
    parseArk(productConfigType, JSON.parse(readFileSync(configFile, "utf8")), "config");
  return { config, configFile, ledger, run, readConfig };
}

describe("local agent selection", () => {
  it("saves each provider without changing other settings or existing conversation data", () => {
    const { config, configFile, ledger, run, readConfig } = fixture();
    chmodSync(configFile, 0o644);
    const selected = run(["use", "claude"]);
    expect(selected.error).toBeUndefined();
    expect(selected.status).toBe(0);
    expect(selected.stdout).toContain("Configured agent: claude");
    expect(selected.stdout).toContain("The service has not been restarted");
    expect(readConfig()).toEqual({
      ...config,
      runtime: { ...config.runtime, agentProvider: "claude" },
    });
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(ledger, "utf8")).toBe("synthetic-existing-ledger");
    const status = run(["status"]);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("Configured agent: claude");
    const restored = run(["use", "codex"]);
    expect(restored.status).toBe(0);
    expect(readConfig()).toEqual(config);
  }, 30_000);

  it("reports Codex for a legacy configuration and preserves it after invalid selection", () => {
    const { config, configFile, run } = fixture();
    const { agentProvider, ...runtime } = config.runtime;
    expect(agentProvider).toBe("codex");
    writeFileSync(configFile, `${JSON.stringify({ ...config, runtime }, null, 2)}\n`);
    const before = readFileSync(configFile, "utf8");
    expect(run(["status"]).stdout).toContain("Configured agent: codex");
    const invalid = run(["use", "unsupported"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("agent provider is invalid");
    expect(readFileSync(configFile, "utf8")).toBe(before);
  }, 30_000);
});
