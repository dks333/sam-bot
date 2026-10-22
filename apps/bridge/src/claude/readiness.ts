import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { codexChildEnvironment } from "../runtime/child-environment.js";

const execute = promisify(execFile);
export const claudeSubscriptionSettings = JSON.stringify({ forceLoginMethod: "claudeai" });

export interface ClaudeReadiness {
  provider: "claude";
  version: string;
  authMethod: "claude.ai";
  subscription: string;
}

export function claudeChildEnvironment(): Record<string, string> {
  return {
    ...codexChildEnvironment(),
    CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
  };
}

export function claudeExecutable(executablePath?: string): string {
  if (executablePath === undefined) return "claude";
  if (!path.isAbsolute(executablePath) || /\p{Cc}/u.test(executablePath)) {
    throw new Error("The Claude executable must be an absolute path");
  }
  return executablePath;
}

const authenticationEnvironmentKeys = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rejectConfiguredBillingOverrides(cwd: string): Promise<void> {
  const candidates = new Set([path.join(os.homedir(), ".claude", "settings.json")]);
  let directory = path.resolve(cwd);
  for (;;) {
    candidates.add(path.join(directory, ".claude", "settings.json"));
    candidates.add(path.join(directory, ".claude", "settings.local.json"));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const file of candidates) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw new Error("Claude authentication settings could not be verified");
    }
    let settings: unknown;
    try {
      settings = JSON.parse(source);
    } catch {
      throw new Error("Claude authentication settings could not be verified");
    }
    if (!isRecord(settings))
      throw new Error("Claude authentication settings could not be verified");
    if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim())
      throw new Error("Claude API key helpers are disabled for subscription mode");
    if (settings.forceLoginMethod !== undefined && settings.forceLoginMethod !== "claudeai")
      throw new Error("Claude settings require a different authentication method");
    if (
      isRecord(settings.env) &&
      Object.keys(settings.env).some((key) => authenticationEnvironmentKeys.has(key.toUpperCase()))
    )
      throw new Error(
        "Claude authentication or provider overrides are disabled for subscription mode",
      );
  }
}

export async function inspectClaudeReadiness(
  options: { executablePath?: string; cwd?: string } = {},
): Promise<ClaudeReadiness> {
  const executable = claudeExecutable(options.executablePath);
  await rejectConfiguredBillingOverrides(options.cwd ?? process.cwd());
  const executionOptions = {
    env: claudeChildEnvironment(),
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
  let version: string;
  let authentication: unknown;
  try {
    const output = await execute(executable, ["--version"], executionOptions);
    version = output.stdout.trim();
    const status = await execute(
      executable,
      ["--settings", claudeSubscriptionSettings, "auth", "status", "--json"],
      executionOptions,
    );
    authentication = JSON.parse(status.stdout);
  } catch {
    throw new Error("Claude Code is unavailable or not signed in. Run claude auth login locally.");
  }
  if (!/^2\.1\.(?:30[6-9]|3[1-9]\d|[4-9]\d{2}|\d{4,})\b/u.test(version)) {
    throw new Error("Claude Code 2.1.306 or newer within version 2.1 is required");
  }
  if (
    typeof authentication !== "object" ||
    authentication === null ||
    !("loggedIn" in authentication) ||
    authentication.loggedIn !== true ||
    !("authMethod" in authentication) ||
    authentication.authMethod !== "claude.ai" ||
    !("apiProvider" in authentication) ||
    authentication.apiProvider !== "firstParty" ||
    ("apiKeySource" in authentication && authentication.apiKeySource !== "none") ||
    !("subscriptionType" in authentication) ||
    typeof authentication.subscriptionType !== "string" ||
    !["pro", "max", "team", "enterprise"].includes(authentication.subscriptionType.toLowerCase())
  ) {
    throw new Error(
      "Claude requires a locally authenticated Pro, Max, Team, or Enterprise subscription; API billing is disabled",
    );
  }
  return {
    provider: "claude",
    version,
    authMethod: "claude.ai",
    subscription: authentication.subscriptionType,
  };
}
