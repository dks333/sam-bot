import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { setTimeout as waitFor } from "node:timers/promises";

import { WebClient } from "@slack/web-api";
import { type } from "arktype";

import { inspectClaudeReadiness } from "../claude/conversation.js";
import { recoverClaudeSession } from "../claude/recovery.js";
import { productPaths } from "../config/paths.js";
import {
  defaultProductConfig,
  loadProduct,
  productConfigType,
  readProductConfig,
} from "../config/product.js";
import { parseArk } from "../validation/parse.js";
import { codexChildEnvironment } from "../runtime/child-environment.js";
import { assertSupportedNodeVersion } from "../runtime/node-version.js";
import { launchAgentPlist } from "./launch-agent.js";
import {
  activateRelease,
  assertRuntimeIdle,
  createReleaseManifest,
  prepareRuntimeSwitch,
  restoreRuntimeSelections,
  runtimeActivity,
  selectedRelease,
  sha256,
  verifyRelease,
  type RuntimeActivity,
} from "./release-manager.js";
import { verifyStagedRuntime } from "./release-smoke.js";
import { launchedRuntimePid, waitForReleaseReadiness } from "./release-readiness.js";
import { recoverFailedActivation } from "./release-recovery.js";
import { secretQuestion } from "./secret-question.js";

const cliInputType = type({
  command: "'setup' | 'doctor' | 'run' | 'service' | 'logs' | 'agent' | 'help'",
  rest: "string[]",
});

const projectRoot = path.resolve(import.meta.dirname, "../../../..");
const paths = productPaths();

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}

function flagValue(arguments_: string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  return index === -1 ? undefined : arguments_[index + 1];
}

function importedEnvironment(): Record<string, string> {
  const envFile = path.join(projectRoot, ".env");
  if (!existsSync(envFile)) {
    return {};
  }
  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

async function question(
  prompt: string,
  fallback: string | undefined,
  arguments_: string[],
  flag: string,
  secret = false,
): Promise<string> {
  const supplied = flagValue(arguments_, flag);
  if (supplied !== undefined) {
    return supplied;
  }
  if (!process.stdin.isTTY) {
    if (fallback === undefined || fallback.length === 0) {
      fail(`Missing ${flag}. Re-run setup interactively or provide the flag.`);
    }
    return fallback;
  }
  if (secret) return secretQuestion(prompt, fallback);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback === undefined || fallback.length === 0 ? "" : ` [${fallback}]`;
    const answer = (await terminal.question(`${prompt}${suffix}: `)).trim();
    if (answer.length > 0) {
      return answer;
    }
    if (fallback !== undefined && fallback.length > 0) {
      return fallback;
    }
    fail(`${prompt} is required.`);
  } finally {
    terminal.close();
  }
}

function ensureDirectories(): void {
  const directories = [paths.home, paths.logsDirectory];
  for (const directory of directories) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    chmodSync(directory, 0o700);
  }
}

async function setup(arguments_: string[]): Promise<void> {
  assertSupportedNodeVersion();
  const savedConfig = existsSync(paths.configFile) ? readProductConfig(paths) : undefined;
  const agentProvider = parseArk(
    type("'codex' | 'claude'"),
    flagValue(arguments_, "--agent") ?? savedConfig?.runtime.agentProvider ?? "codex",
    "agent provider",
  );
  if (existsSync(paths.configFile) && !arguments_.includes("--force")) {
    fail(`${paths.configFile} already exists. Use --force to replace it.`);
  }
  ensureDirectories();
  const existingSecrets = existsSync(paths.secretsFile)
    ? readFileSync(paths.secretsFile, "utf8")
    : "";
  const imported = { ...importedEnvironment(), ...parseEnv(existingSecrets) };
  const base = savedConfig ?? defaultProductConfig(projectRoot);
  const teamId = await question(
    "Slack team ID",
    imported.SLACK_ALLOWED_TEAM_ID ?? savedConfig?.slack.allowedTeamId,
    arguments_,
    "--team",
  );
  const userId = await question(
    "Your immutable Slack user ID",
    imported.SLACK_ALLOWED_USER_ID ?? savedConfig?.slack.allowedUserId,
    arguments_,
    "--user",
  );
  const channelFlag = flagValue(arguments_, "--channel");
  const importedChannels =
    imported.SLACK_ALLOWED_CHANNEL_IDS?.split(",")
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0) ?? savedConfig?.slack.allowedChannelIds;
  const allowedChannelIds =
    channelFlag === undefined && importedChannels !== undefined && importedChannels.length > 0
      ? importedChannels
      : [
          await question(
            "Allowed Slack channel ID",
            importedChannels?.[0],
            arguments_,
            "--channel",
          ),
        ];
  const workspaceFlag = flagValue(arguments_, "--workspace");
  let importedWorkspaces: Record<string, string> | undefined;
  if (workspaceFlag === undefined) {
    importedWorkspaces = savedConfig?.workspaces;
    if (imported.BRIDGE_WORKSPACES_JSON !== undefined)
      importedWorkspaces = parseArk(
        type("string.json.parse").to({
          "[string]": "string",
        }),
        imported.BRIDGE_WORKSPACES_JSON,
        "imported workspace registry",
      );
  }
  let workspaces: Record<string, string>;
  if (importedWorkspaces === undefined) {
    const workspaceRoot = path.resolve(
      await question(
        "Default workspace path",
        Object.values(base.workspaces)[0],
        arguments_,
        "--workspace",
      ),
    );
    workspaces = { default: workspaceRoot };
  } else {
    workspaces = importedWorkspaces;
  }
  for (const [alias, workspaceRoot] of Object.entries(workspaces)) {
    if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
      fail(`Workspace "${alias}" does not exist: ${workspaceRoot}`);
    }
  }
  const botToken = await question(
    "Slack bot token",
    imported.SLACK_BOT_TOKEN,
    arguments_,
    "--bot-token",
    true,
  );
  const appToken = await question(
    "Slack app-level token",
    imported.SLACK_APP_TOKEN,
    arguments_,
    "--app-token",
    true,
  );
  if (!arguments_.includes("--skip-connectivity-check")) {
    const auth = await new WebClient(botToken).auth.test();
    if (auth.team_id !== teamId) {
      fail(`The bot token belongs to team ${auth.team_id ?? "unknown"}, not ${teamId}.`);
    }
    const socketResponse = await fetch("https://slack.com/api/apps.connections.open", {
      headers: {
        Authorization: `Bearer ${appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const socketResult = parseArk(
      type("string.json.parse").to({
        "error?": "string",
        ok: "boolean",
        "url?": "string",
      }),
      await socketResponse.text(),
      "Slack Socket Mode verification",
    );
    if (!socketResult.ok || socketResult.url === undefined) {
      fail(`Slack rejected the app token: ${socketResult.error ?? "unknown error"}`);
    }
  }
  const workspaceAliases = Object.keys(workspaces);
  const importedDefaultAlias = imported.SLACK_DEFAULT_WORKSPACE_ALIAS;
  let defaultWorkspaceAlias: string | undefined;
  if (importedDefaultAlias !== undefined && Object.hasOwn(workspaces, importedDefaultAlias)) {
    defaultWorkspaceAlias = importedDefaultAlias;
  } else if (workspaceAliases.length === 1) {
    defaultWorkspaceAlias = workspaceAliases[0];
  }
  const configCandidate = {
    ...base,
    runtime: {
      ...base.runtime,
      agentProvider,
      ...(defaultWorkspaceAlias === undefined ? {} : { defaultWorkspaceAlias }),
    },
    slack: {
      ...base.slack,
      allowedChannelIds,
      allowedTeamId: teamId,
      allowedUserId: userId,
      ...(imported.SLACK_ALLOWED_ENTERPRISE_ID === undefined
        ? {}
        : { allowedEnterpriseId: imported.SLACK_ALLOWED_ENTERPRISE_ID }),
    },
    workspaces,
  };
  const config = parseArk(productConfigType, configCandidate, "setup configuration");
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(paths.configFile, 0o600);
  let secrets = existingSecrets;
  const previousTokens = parseEnv(existingSecrets);
  if (previousTokens.SLACK_BOT_TOKEN !== botToken || previousTokens.SLACK_APP_TOKEN !== appToken) {
    if (secrets.length > 0 && !secrets.endsWith("\n")) secrets += "\n";
    secrets += `SLACK_BOT_TOKEN=${botToken}\nSLACK_APP_TOKEN=${appToken}\n`;
  }
  writeFileSync(paths.secretsFile, secrets, { encoding: "utf8", mode: 0o600 });
  chmodSync(paths.secretsFile, 0o600);
  loadProduct(paths);
  print(`Setup complete in ${paths.home}`);
  print("Next: pnpm sam-bot doctor");
  if (agentProvider === "claude") {
    print("If Claude Code authentication is missing: claude auth login");
  } else {
    print("If Codex authentication is missing: pnpm --dir apps/bridge exec codex login");
  }
}

interface DoctorCheck {
  detail: string;
  name: string;
  passed: boolean;
}

function check(name: string, operation: () => string): DoctorCheck {
  try {
    return { detail: operation(), name, passed: true };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : "Unknown failure",
      name,
      passed: false,
    };
  }
}

async function doctor(): Promise<void> {
  const checks: DoctorCheck[] = [];
  const nodeCheck = check("Node.js", () => {
    assertSupportedNodeVersion();
    return process.versions.node;
  });
  checks.push(nodeCheck);
  if (!nodeCheck.passed) {
    print(`✗ ${nodeCheck.name}: ${nodeCheck.detail}`);
    process.exitCode = 1;
    return;
  }
  let product: ReturnType<typeof loadProduct> | undefined;
  checks.push(
    check("Configuration", () => {
      product = loadProduct(paths);
      return paths.configFile;
    }),
  );
  checks.push(
    check("Secret permissions", () => {
      const mode = statSync(paths.secretsFile).mode & 0o777;
      if (mode !== 0o600) {
        fail(`Expected 0600, found ${mode.toString(8)}`);
      }
      return "0600";
    }),
  );
  checks.push(
    check("State permissions", () => {
      const homeMode = statSync(paths.home).mode & 0o777;
      const configMode = statSync(paths.configFile).mode & 0o777;
      if (homeMode !== 0o700 || configMode !== 0o600) {
        fail(
          `Expected product home 0700 and config 0600, found ${homeMode.toString(8)} and ${configMode.toString(8)}`,
        );
      }
      return "home 0700; config 0600";
    }),
  );
  checks.push(
    check("SQLite", () => {
      if (!existsSync(paths.databaseFile)) {
        return "not initialized; startup will create the database";
      }
      const activity = runtimeActivity(paths.databaseFile);
      return `read-only inspection passed; schema ${activity.schemaVersion}`;
    }),
  );
  checks.push(
    check("Workspaces", () => {
      const config = product?.config ?? readProductConfig(paths);
      for (const root of Object.values(config.workspaces)) {
        if (!existsSync(root) || !statSync(root).isDirectory()) {
          fail(`Missing ${root}`);
        }
      }
      return Object.keys(config.workspaces).join(", ");
    }),
  );
  const agentProvider = product?.config.runtime.agentProvider ?? "codex";
  checks.push(
    check("Slack manifest scopes", () => {
      const manifest = readFileSync(path.join(projectRoot, "slack-app-manifest.yaml"), "utf8");
      const required = [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "files:read",
        "files:write",
        "groups:history",
        "im:history",
        "message.im",
        "reactions:write",
      ];
      const missing = required.filter((scope) => !manifest.includes(scope));
      if (missing.length > 0) {
        fail(`Missing ${missing.join(", ")}`);
      }
      return required.join(", ");
    }),
  );
  if (agentProvider === "claude") {
    try {
      const workspaceAlias =
        product?.bridge.defaultWorkspaceAlias ?? Object.keys(product?.bridge.workspaces ?? {})[0];
      const cwd =
        workspaceAlias === undefined ? undefined : product?.bridge.workspaces[workspaceAlias];
      const readiness = await inspectClaudeReadiness({
        ...product?.config.claude,
        ...(cwd === undefined ? {} : { cwd }),
      });
      checks.push({
        name: "Claude Code subscription",
        detail: `${readiness.version}; ${readiness.authMethod}; ${readiness.subscription ?? "subscription authenticated"}`,
        passed: true,
      });
    } catch (error) {
      checks.push({
        name: "Claude Code subscription",
        detail: error instanceof Error ? error.message : "Claude Code is not authenticated",
        passed: false,
      });
    }
  } else {
    checks.push(
      check("Codex authentication", () => {
        const codexExecutable =
          product?.config.codex.executablePath ??
          path.join(projectRoot, "apps", "bridge", "node_modules", ".bin", "codex");
        const result = spawnSync(codexExecutable, ["login", "status"], {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          env: {
            ...codexChildEnvironment(),
            ...(product?.bridge.codexHome === undefined
              ? {}
              : { CODEX_HOME: product.bridge.codexHome }),
          },
        });
        if (result.status !== 0) {
          fail((result.stderr || result.stdout || "Codex is not authenticated").trim());
        }
        return result.stdout.trim() || "authenticated";
      }),
    );
  }
  if (product !== undefined) {
    try {
      const auth = await new WebClient(product.secrets.SLACK_BOT_TOKEN).auth.test();
      checks.push({
        detail: `${auth.team_id ?? "unknown team"} / ${auth.user_id ?? "unknown bot"}`,
        name: "Slack connectivity",
        passed: true,
      });
    } catch (error) {
      checks.push({
        detail: error instanceof Error ? error.message : "Slack auth.test failed",
        name: "Slack connectivity",
        passed: false,
      });
    }
  }
  checks.push({
    detail: existsSync(paths.launchAgentFile) ? paths.launchAgentFile : "not installed",
    name: "LaunchAgent",
    passed: true,
  });

  for (const result of checks) {
    print(`${result.passed ? "✓" : "✗"} ${result.name}: ${result.detail}`);
  }
  if (checks.some((result) => !result.passed)) {
    process.exitCode = 1;
  }
}

function runLaunchctl(arguments_: string[]): void {
  const result = spawnSync("/bin/launchctl", arguments_, { encoding: "utf8" });
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || "launchctl failed").trim());
  }
}

function checkedSourceCommand(program: string, arguments_: string[]): string {
  const result = spawnSync(program, arguments_, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${program} ${arguments_.join(" ")} failed; no runtime was changed.`);
  }
  return result.stdout.trim();
}

function assertCleanSource(): string {
  const status = checkedSourceCommand("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.length > 0) {
    fail(
      "Refusing to build an immutable release from mixed or uncommitted source. Isolate and commit the reviewed change first.",
    );
  }
  return checkedSourceCommand("git", ["rev-parse", "HEAD"]);
}

function stageRelease(): string {
  const commit = assertCleanSource();
  const rootPackage: unknown = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const metadata = parseArk(
    type({ packageManager: "string" }),
    rootPackage,
    "release package manager",
  );
  if (!/^pnpm@\d+\.\d+\.\d+$/u.test(metadata.packageManager)) {
    fail("Release builds require the repository's exact declared pnpm version.");
  }
  const lockHash = sha256(readFileSync(path.join(projectRoot, "pnpm-lock.yaml")));
  for (const script of ["type", "lint", "format", "test", "build"]) {
    const validationArguments = [metadata.packageManager, "--dir", projectRoot, script];
    if (script === "test") {
      validationArguments.push("--maxWorkers=2");
    }
    const check = spawnSync("corepack", validationArguments, {
      cwd: projectRoot,
      stdio: "inherit",
    });
    if (check.status !== 0) {
      fail(`Release validation ${script} failed; no runtime was changed.`);
    }
  }
  if (
    assertCleanSource() !== commit ||
    sha256(readFileSync(path.join(projectRoot, "pnpm-lock.yaml"))) !== lockHash
  ) {
    fail("Release source changed during validation; no runtime was changed.");
  }
  const releasesDirectory = path.join(paths.home, "releases");
  mkdirSync(releasesDirectory, { mode: 0o700, recursive: true });
  const releaseId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const stagingDirectory = mkdtempSync(path.join(releasesDirectory, ".staging-"));
  try {
    const deploy = spawnSync(
      "corepack",
      [
        metadata.packageManager,
        "--config.inject-workspace-packages=true",
        "--filter",
        "@sam-bot/bridge",
        "deploy",
        "--prod",
        "--ignore-scripts",
        stagingDirectory,
      ],
      { cwd: projectRoot, stdio: "inherit" },
    );
    if (deploy.status !== 0) {
      fail("Portable runtime deployment failed; no runtime was changed.");
    }
    const stagedBridgeEntry = path.join(stagingDirectory, "dist", "index.js");
    const syntax = spawnSync(process.execPath, ["--check", stagedBridgeEntry], {
      encoding: "utf8",
    });
    if (syntax.status !== 0) {
      fail("The staged runtime entry point failed validation.");
    }
    const bridgePackage: unknown = JSON.parse(
      readFileSync(path.join(stagingDirectory, "package.json"), "utf8"),
    );
    const bridge = parseArk(
      type({ dependencies: { "@openai/codex": "string" } }),
      bridgePackage,
      "staged Codex dependency",
    );
    const { maximumSchemaVersion, maximumNativeSchemaVersion } = verifyStagedRuntime(
      stagingDirectory,
      bridge.dependencies["@openai/codex"],
    );
    writeFileSync(
      path.join(stagingDirectory, "source-lock.yaml"),
      readFileSync(path.join(projectRoot, "pnpm-lock.yaml")),
      { mode: 0o600 },
    );
    createReleaseManifest({
      agentProviders: ["codex", "claude"],
      codexVersion: bridge.dependencies["@openai/codex"],
      createdAt: new Date().toISOString(),
      directory: stagingDirectory,
      maximumSchemaVersion,
      maximumNativeSchemaVersion,
      packageManager: metadata.packageManager,
      policyVersion: "native-conversation-v1",
      releaseId,
      sourceClean: true,
      sourceCommit: commit,
      sourceLockHash: lockHash,
    });
    const releaseDirectory = path.join(releasesDirectory, releaseId);
    renameSync(stagingDirectory, releaseDirectory);
    const activity = runtimeActivity(paths.databaseFile);
    verifyRelease(releaseDirectory, activity.schemaVersion, activity.nativeSchemaVersion);
    return releaseDirectory;
  } catch (error) {
    rmSync(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

function writeLaunchAgent(directory: string): void {
  const temporary = `${paths.launchAgentFile}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(paths.launchAgentFile), { recursive: true });
  writeFileSync(
    temporary,
    launchAgentPlist(paths, process.execPath, path.join(directory, "dist", "index.js"), directory),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, paths.launchAgentFile);
}

async function switchRuntime(directory: string, domain: string): Promise<void> {
  const drainFile = path.join(paths.home, "drain.json");
  const { activity, previous, previousSelection, previousPlist, wasDraining } =
    prepareRuntimeSwitch({
      databaseFile: paths.databaseFile,
      directory,
      home: paths.home,
      launchAgentFile: paths.launchAgentFile,
    });
  spawnSync("/bin/launchctl", ["bootout", domain, paths.launchAgentFile]);
  let stoppedActivity: RuntimeActivity;
  try {
    stoppedActivity = assertRuntimeIdle(paths.databaseFile);
  } catch {
    fail(
      "The service was stopped, but persisted work remains active. No runtime or task state was replaced. Start the preserved runtime to reconcile interrupted work before trying the upgrade again.",
    );
  }
  const startedAfter = new Date().toISOString();
  try {
    const manifest = activateRelease(
      paths.home,
      directory,
      stoppedActivity.schemaVersion,
      stoppedActivity.nativeSchemaVersion,
    );
    const current = path.join(paths.home, "runtime-current");
    writeLaunchAgent(current);
    runLaunchctl(["bootstrap", domain, paths.launchAgentFile]);
    await waitForReleaseReadiness({
      agentProvider: readProductConfig(paths).runtime.agentProvider ?? "codex",
      releaseId: manifest.releaseId,
      sourceCommit: manifest.sourceCommit,
      startedAfter,
      readHealth: () =>
        JSON.parse(readFileSync(path.join(paths.home, "runtime-health.json"), "utf8")),
      readPid: () => {
        const status = spawnSync("/bin/launchctl", ["print", `${domain}/com.local.codex-slack`], {
          encoding: "utf8",
          timeout: 1_000,
        });
        if (status.status !== 0) return undefined;
        return launchedRuntimePid(status.stdout);
      },
      isPidAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      wait: waitFor,
    });
    if (!wasDraining) {
      unlinkSync(drainFile);
    }
    print(`Selected verified release ${manifest.releaseId}. Previous releases were retained.`);
  } catch (error) {
    recoverFailedActivation(error, () => {
      spawnSync("/bin/launchctl", ["bootout", domain, paths.launchAgentFile]);
      const currentActivity = runtimeActivity(paths.databaseFile);
      restoreRuntimeSelections({
        failedDirectory: directory,
        home: paths.home,
        priorSchemaVersion: activity.schemaVersion,
        schemaVersion: currentActivity.schemaVersion,
        nativeSchemaVersion: currentActivity.nativeSchemaVersion,
        priorNativeSchemaVersion: activity.nativeSchemaVersion,
        ...(previous === undefined ? {} : { priorCurrent: previous }),
        ...(previousSelection === undefined ? {} : { priorPrevious: previousSelection }),
      });
      if (previousPlist !== undefined) {
        writeFileSync(paths.launchAgentFile, previousPlist, { mode: 0o600 });
        runLaunchctl(["bootstrap", domain, paths.launchAgentFile]);
      }
    });
  }
}

async function service(operation: string | undefined, releaseId?: string): Promise<void> {
  if (operation === "stage") {
    print(stageRelease());
    return;
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    fail("LaunchAgent service management is supported only on macOS.");
  }
  const domain = `gui/${uid}`;
  if (operation === "activate") {
    if (releaseId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(releaseId)) {
      fail("Activation requires the staged release ID shown in its manifest.");
    }
    const releasesDirectory = realpathSync(path.join(paths.home, "releases"));
    const directory = realpathSync(path.join(releasesDirectory, releaseId));
    const relative = path.relative(releasesDirectory, directory);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail("Activation must select a release inside the product's release directory.");
    }
    ensureDirectories();
    loadProduct(paths);
    await switchRuntime(directory, domain);
    return;
  }
  if (operation === "install") {
    assertRuntimeIdle(paths.databaseFile);
    ensureDirectories();
    loadProduct(paths);
    const directory = stageRelease();
    await switchRuntime(directory, domain);
    return;
  }
  if (operation === "rollback") {
    const previous = selectedRelease(paths.home, "runtime-previous");
    if (previous === undefined) {
      fail(
        "No verified previous release is selected. The legacy runtime has been preserved for explicit recovery.",
      );
    }
    await switchRuntime(previous, domain);
    return;
  }
  if (operation === "drain") {
    ensureDirectories();
    writeFileSync(
      path.join(paths.home, "drain.json"),
      `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    const selected = selectedRelease(paths.home);
    if (selected === undefined) {
      print(
        "Drain requested. Legacy runtimes do not read the drain marker; stop the legacy service explicitly and reconcile its work before upgrading.",
      );
    } else {
      print(
        `Drain requested. Existing work and controls remain available. Activity: ${JSON.stringify(runtimeActivity(paths.databaseFile))}`,
      );
    }
    return;
  }
  if (operation === "resume") {
    const drainFile = path.join(paths.home, "drain.json");
    if (existsSync(drainFile)) {
      unlinkSync(drainFile);
    }
    print("Execution intake resumed.");
    return;
  }
  if (operation === "start") {
    const provider = readProductConfig(paths).runtime.agentProvider ?? "codex";
    const selected = selectedRelease(paths.home);
    if (selected !== undefined) {
      const activity = runtimeActivity(paths.databaseFile);
      verifyRelease(selected, activity.schemaVersion, activity.nativeSchemaVersion, provider);
    } else if (provider === "claude") {
      fail("Activate a managed release supporting Claude before starting the service.");
    }
    const loaded = spawnSync("/bin/launchctl", ["print", `${domain}/com.local.codex-slack`], {
      encoding: "utf8",
    });
    if (loaded.status === 0) {
      assertRuntimeIdle(paths.databaseFile);
      runLaunchctl(["kickstart", "-k", `${domain}/com.local.codex-slack`]);
    } else {
      runLaunchctl(["bootstrap", domain, paths.launchAgentFile]);
    }
    print("Sam Bot service started.");
    return;
  }
  if (operation === "stop") {
    runLaunchctl(["bootout", domain, paths.launchAgentFile]);
    print("Sam Bot service stopped.");
    return;
  }
  if (operation === "status") {
    const result = spawnSync("/bin/launchctl", ["print", `${domain}/com.local.codex-slack`], {
      encoding: "utf8",
    });
    print(result.status === 0 ? result.stdout.trim() : "Service is not loaded.");
    if (result.status !== 0) {
      process.exitCode = 1;
    }
    return;
  }
  if (operation === "uninstall") {
    spawnSync("/bin/launchctl", ["bootout", domain, paths.launchAgentFile]);
    if (existsSync(paths.launchAgentFile)) {
      const trashDirectory = path.join(paths.home, "uninstalled");
      mkdirSync(trashDirectory, { mode: 0o700, recursive: true });
      writeFileSync(
        path.join(trashDirectory, `launch-agent-${Date.now()}.plist`),
        readFileSync(paths.launchAgentFile),
        { mode: 0o600 },
      );
      unlinkSync(paths.launchAgentFile);
    }
    print("LaunchAgent uninstalled. Product data was preserved.");
    return;
  }
  fail(
    "Usage: pnpm sam-bot service stage|activate RELEASE_ID|install|start|stop|status|uninstall|drain|resume|rollback",
  );
}

function logs(): void {
  const candidates = ["bridge.log", "bridge.error.log", "launchd-output.log"];
  let found = false;
  for (const name of candidates) {
    const logFile = path.join(paths.logsDirectory, name);
    if (existsSync(logFile)) {
      found = true;
      print(`== ${name} ==`);
      const lines = readFileSync(logFile, "utf8").trimEnd().split("\n");
      print(lines.slice(-200).join("\n"));
    }
  }
  if (!found) {
    print("No service logs yet.");
  }
}

function agent(arguments_: string[]): void {
  const config = readProductConfig(paths);
  if (arguments_[0] === "recover") {
    const sessionId = arguments_[1];
    if (sessionId === undefined || arguments_.length !== 3 || arguments_[2] !== "--confirm-stopped")
      fail(
        "Usage: pnpm sam-bot agent recover SESSION_UUID --confirm-stopped. Stop the bridge, Claude process, and independent tools before confirming.",
      );
    const recovered = recoverClaudeSession({
      home: paths.home,
      provider: config.runtime.agentProvider ?? "codex",
      sessionId,
      confirmedStopped: true,
    });
    print(
      `Recorded local recovery for Claude session ${recovered.sessionId}, turn ${recovered.turnId}.`,
    );
    print(
      "The previous outcome remains unknown. No prompt was replayed; queued follow-ups were canceled.",
    );
    print(`Recovery evidence: ${recovered.recoveryRecord}`);
    return;
  }
  if (arguments_[0] === "status" && arguments_.length === 1) {
    print(`Configured agent: ${config.runtime.agentProvider ?? "codex"}`);
    print("Configuration applies when the runtime next starts.");
    return;
  }
  if (arguments_[0] !== "use" || arguments_.length !== 2) {
    fail("Usage: pnpm sam-bot agent status|use claude|codex");
  }
  const provider = parseArk(type("'codex' | 'claude'"), arguments_[1], "agent provider");
  const updated = parseArk(
    productConfigType,
    { ...config, runtime: { ...config.runtime, agentProvider: provider } },
    "agent configuration",
  );
  const temporary = `${paths.configFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, paths.configFile);
  } finally {
    rmSync(temporary, { force: true });
  }
  print(`Configured agent: ${provider}`);
  print("Restart the local runtime to apply this setting. The service has not been restarted.");
}

function help(): void {
  print(`Sam Bot

pnpm sam-bot setup [--team ID --user ID --channel ID --workspace PATH --agent codex|claude]
pnpm sam-bot agent status|use claude|codex
pnpm sam-bot agent recover SESSION_UUID --confirm-stopped
pnpm sam-bot doctor
pnpm sam-bot run
pnpm sam-bot service stage|activate RELEASE_ID|install|start|stop|status|uninstall|drain|resume|rollback
pnpm sam-bot logs
`);
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  const input = parseArk(cliInputType, { command, rest }, "CLI arguments");
  if (input.command === "run" || input.command === "service" || input.command === "agent")
    assertSupportedNodeVersion();
  switch (input.command) {
    case "setup":
      await setup(input.rest);
      return;
    case "doctor":
      await doctor();
      return;
    case "run":
      await import("../index.js");
      return;
    case "service":
      await service(input.rest[0], input.rest[1]);
      return;
    case "logs":
      logs();
      return;
    case "agent":
      agent(input.rest);
      return;
    case "help":
      help();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
