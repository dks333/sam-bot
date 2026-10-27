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

const terminalDriver = `import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

master, slave = pty.openpty()
child = subprocess.Popen(json.loads(sys.argv[1]), stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
transcript = bytearray()
deadline = time.monotonic() + 15

def read_output():
    if time.monotonic() > deadline:
        child.kill()
        raise TimeoutError("Synthetic terminal setup timed out")
    if not select.select([master], [], [], 0.1)[0]:
        return True
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    transcript.extend(chunk)
    return bool(chunk)

try:
    for prompt, answer in json.loads(sys.argv[2]):
        while prompt.encode() not in transcript:
            if not read_output():
                raise RuntimeError("Setup exited before a synthetic token prompt")
        os.write(master, answer.encode() + b"\\n")
    while read_output():
        pass
    child.wait(timeout=2)
finally:
    os.close(master)
    if child.poll() is None:
        child.kill()
        child.wait()
sys.stdout.write(transcript.decode(errors="replace"))
sys.exit(child.returncode)
`;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-cli-setup-"));
  directories.push(directory);
  const command = (arguments_: string[]) => [
    process.execPath,
    "--import",
    import.meta.resolve("tsx"),
    path.resolve(import.meta.dirname, "../src/cli/index.ts"),
    "setup",
    "--skip-connectivity-check",
    ...arguments_,
  ];
  const environment = { HOME: directory, PATH: process.env.PATH, SLACK_CODEX_HOME: directory };
  const run = (arguments_: string[]) =>
    spawnSync(process.execPath, command(arguments_).slice(1), {
      encoding: "utf8",
      env: environment,
      timeout: 20_000,
    });
  const runTerminal = (arguments_: string[], responses: [string, string][]) =>
    spawnSync(
      "python3",
      ["-c", terminalDriver, JSON.stringify(command(arguments_)), JSON.stringify(responses)],
      { encoding: "utf8", env: environment, timeout: 20_000 },
    );
  return { directory, paths: productPaths(directory), run, runTerminal };
}

describe("native setup", () => {
  it.skipIf(process.platform === "win32")(
    "hides typed and saved Slack tokens in a real terminal",
    () => {
      const { directory, paths, run, runTerminal } = fixture();
      const metadata = [
        "--team",
        "synthetic-team",
        "--user",
        "synthetic-owner",
        "--channel",
        "synthetic-channel",
        "--workspace",
        directory,
      ];
      expect(
        run([
          ...metadata,
          "--bot-token",
          "xoxb-synthetic-saved",
          "--app-token",
          "xapp-synthetic-saved",
        ]).status,
      ).toBe(0);
      const result = runTerminal(
        [...metadata, "--force"],
        [
          ["Slack bot token [press Enter to keep saved value]: ", "xoxb-synthetic-replacement"],
          ["Slack app-level token [press Enter to keep saved value]: ", ""],
        ],
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Setup complete");
      expect(result.stdout).not.toContain("xoxb-synthetic-saved");
      expect(result.stdout).not.toContain("xapp-synthetic-saved");
      expect(result.stdout).not.toContain("xoxb-synthetic-replacement");
      expect(readProductSecrets(paths)).toEqual({
        SLACK_BOT_TOKEN: "xoxb-synthetic-replacement",
        SLACK_APP_TOKEN: "xapp-synthetic-saved",
      });
    },
    30_000,
  );

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
