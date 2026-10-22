import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { defaultProductConfig } from "../src/config/product.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture(agentProvider?: "claude") {
  const directory = mkdtempSync(path.join(tmpdir(), "cli-doctor-"));
  directories.push(directory);
  const preload = path.join(directory, "isolated-subprocess.mjs");
  const calls = path.join(directory, "subprocess-calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(
    preload,
    `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { WebClient } from ${JSON.stringify(import.meta.resolve("@slack/web-api"))};
childProcess.spawnSync = (executable, arguments_) => {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ executable, arguments_ }) + "\\n");
  return { status: 0, stdout: "synthetic-auth", stderr: "" };
};
syncBuiltinESMExports();
WebClient.prototype.apiCall = async () => ({ ok: true, team_id: "T_SYNTHETIC", user_id: "U_SYNTHETIC" });
globalThis.fetch = () => { throw new Error("External requests are forbidden in this fixture"); };
`,
  );
  if (agentProvider === "claude") {
    const executablePath = path.join(directory, "synthetic-claude.mjs");
    writeFileSync(
      executablePath,
      `#!${process.execPath}
if (process.argv.includes("--version")) process.stdout.write("2.1.306 (Claude Code)\\n");
else process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }));
`,
      { mode: 0o700 },
    );
    const base = defaultProductConfig(directory);
    writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify({
        ...base,
        claude: { executablePath },
        runtime: { ...base.runtime, agentProvider },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(directory, "secrets.env"),
      "SLACK_APP_TOKEN=xapp-synthetic\nSLACK_BOT_TOKEN=xoxb-synthetic\n",
      { mode: 0o600 },
    );
  }
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        "doctor",
      ],
      {
        encoding: "utf8",
        env: { HOME: directory, PATH: process.env.PATH, SLACK_CODEX_HOME: directory },
        timeout: 20_000,
      },
    );
  return { directory, filename: path.join(directory, "bridge.sqlite"), calls, run };
}

describe("doctor database inspection", () => {
  it("checks the selected Claude subscription without invoking Codex authentication", () => {
    const { filename, calls, run } = fixture("claude");
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Claude Code subscription: 2.1.306 (Claude Code); claude.ai; max",
    );
    expect(result.stdout).not.toContain("Codex authentication");
    expect(result.stdout).not.toContain("Codex packages");
    expect(readFileSync(calls, "utf8")).not.toContain("codex");
    expect(existsSync(filename)).toBe(false);
  }, 30_000);

  it("checks billing overrides in the configured workspace before declaring Claude ready", () => {
    const { directory, run } = fixture("claude");
    mkdirSync(path.join(directory, ".claude"));
    writeFileSync(
      path.join(directory, ".claude", "settings.json"),
      JSON.stringify({ apiKeyHelper: "printf synthetic" }),
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Claude API key helpers are disabled for subscription mode");
  }, 30_000);

  it("keeps a legacy database and its schema unchanged", () => {
    const { directory, filename, run } = fixture();
    const database = new Database(filename);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER); INSERT INTO schema_migrations VALUES (9); CREATE TABLE synthetic_records (value TEXT); INSERT INTO synthetic_records VALUES ('preserve-this-record');",
    );
    database.close();
    chmodSync(filename, 0o600);
    const before = createHash("sha256").update(readFileSync(filename)).digest("hex");
    const files = readdirSync(directory).sort();
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("SQLite: read-only inspection passed; schema 9");
    expect(createHash("sha256").update(readFileSync(filename)).digest("hex")).toBe(before);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory).sort()).toEqual(files);
    const inspected = new Database(filename, { fileMustExist: true, readonly: true });
    try {
      expect(
        inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
      ).toEqual({
        version: 9,
      });
      expect(inspected.prepare("SELECT value FROM synthetic_records").get()).toEqual({
        value: "preserve-this-record",
      });
    } finally {
      inspected.close();
    }
  });

  it("does not create a missing database during diagnosis", () => {
    const { filename, run } = fixture();
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("SQLite: not initialized; startup will create the database");
    expect(existsSync(filename)).toBe(false);
  });
});
