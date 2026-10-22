import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultProductConfig,
  readProductConfig,
  readProductSecrets,
} from "../src/config/product.js";
import { productPaths } from "../src/config/paths.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-cli-setup-"));
  directories.push(directory);
  const run = (arguments_: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.resolve(import.meta.dirname, "../src/cli/index.ts"),
        "setup",
        "--skip-connectivity-check",
        ...arguments_,
      ],
      {
        encoding: "utf8",
        env: { HOME: directory, PATH: process.env.PATH, SLACK_CODEX_HOME: directory },
        timeout: 20_000,
      },
    );
  return { directory, paths: productPaths(directory), run };
}

describe("native setup", () => {
  it("creates native settings and Slack secrets without creating retired runtime files", () => {
    const { directory, paths, run } = fixture();
    const result = run([
      "--team",
      "synthetic-team",
      "--user",
      "synthetic-owner",
      "--channel",
      "synthetic-channel",
      "--workspace",
      directory,
      "--bot-token",
      "xoxb-synthetic",
      "--app-token",
      "xapp-synthetic",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readProductConfig(paths).runtime.agentProvider).toBe("codex");
    expect(readProductSecrets(paths).SLACK_APP_TOKEN).toBe("xapp-synthetic");
    expect(readdirSync(directory).sort()).toEqual(["config.json", "logs", "secrets.env"]);
  }, 30_000);

  it("preserves existing native options, unknown settings, retained files, and secret text during forced setup", () => {
    const { directory, paths, run } = fixture();
    const saved = {
      ...defaultProductConfig(directory),
      codex: { home: "/synthetic/codex-profile", executablePath: "/synthetic/bin/codex" },
      claude: { executablePath: "/synthetic/bin/claude", model: "synthetic-model" },
      runtime: {
        agentProvider: "claude",
        logLevel: "info",
        maxSlackResponseChars: 3500,
        defaultWorkspaceAlias: "synthetic",
      },
      slack: {
        allowedTeamId: "synthetic-team",
        allowedUserId: "synthetic-owner",
        allowedChannelIds: ["synthetic-channel"],
      },
      workspaces: { synthetic: directory },
      routing: { retained: true },
    };
    writeFileSync(paths.configFile, JSON.stringify(saved), { mode: 0o600 });
    const secrets =
      'SLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\nTYPESAFE_API_KEY=synthetic-retained\nFUTURE_VALUE="synthetic\nmultiline"\n';
    writeFileSync(paths.secretsFile, secrets, { mode: 0o600 });
    mkdirSync(path.join(directory, "prompts"));
    writeFileSync(path.join(directory, "prompts", "retained.md"), "synthetic retained content");
    const result = run(["--force"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(readProductConfig(paths)).toEqual(saved);
    expect(readFileSync(paths.secretsFile, "utf8")).toBe(secrets);
    expect(readFileSync(path.join(directory, "prompts", "retained.md"), "utf8")).toBe(
      "synthetic retained content",
    );
  }, 30_000);
});
