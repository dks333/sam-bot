import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { type } from "arktype";

import { parseArk } from "../validation/parse.js";
import type { BridgeConfig } from "./env.js";
import { productPaths, type ProductPaths } from "./paths.js";

const aliasPattern = /^[a-z0-9][a-z0-9-]*$/u;

export const productConfigType = type({
  "claude?": {
    "executablePath?": "string",
    "model?": "string",
  },
  codex: {
    "executablePath?": "string",
    "home?": "string",
  },
  runtime: {
    "agentProvider?": "'codex' | 'claude'",
    "defaultWorkspaceAlias?": "string",
    logLevel: "'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'",
    maxSlackResponseChars: "500 <= number.integer <= 39000",
  },
  slack: {
    allowedChannelIds: "string[]",
    "allowedEnterpriseId?": "string",
    allowedTeamId: "string",
    allowedUserId: "string",
  },
  version: "1",
  workspaces: {
    "[string]": "string",
  },
}).narrow((config) => {
  const entries = Object.entries(config.workspaces);
  const aliasesValid =
    entries.length > 0 &&
    entries.every(
      ([alias, root]) =>
        aliasPattern.test(alias) && path.isAbsolute(root) && root.trim().length > 0,
    );
  const defaultAlias = config.runtime.defaultWorkspaceAlias;
  return (
    aliasesValid &&
    config.slack.allowedChannelIds.length > 0 &&
    (defaultAlias === undefined || Object.hasOwn(config.workspaces, defaultAlias))
  );
});

export type ProductConfig = typeof productConfigType.infer;

const productConfigJsonType = type("string.json.parse").to(productConfigType);

const secretsType = type({
  SLACK_APP_TOKEN: "/^xapp-/",
  SLACK_BOT_TOKEN: "/^xoxb-/",
});

export type ProductSecrets = typeof secretsType.infer;

export interface LoadedProduct {
  bridge: BridgeConfig;
  config: ProductConfig;
  paths: ProductPaths;
  secrets: ProductSecrets;
}

export function defaultProductConfig(workspaceRoot: string): ProductConfig {
  return {
    codex: { home: path.join(os.homedir(), ".codex") },
    runtime: {
      agentProvider: "codex",
      defaultWorkspaceAlias: "default",
      logLevel: "info",
      maxSlackResponseChars: 3500,
    },
    slack: {
      allowedChannelIds: ["REPLACE_WITH_CHANNEL_ID"],
      allowedTeamId: "REPLACE_WITH_TEAM_ID",
      allowedUserId: "REPLACE_WITH_USER_ID",
    },
    version: 1,
    workspaces: {
      default: path.resolve(workspaceRoot),
    },
  };
}

export function readProductConfig(paths = productPaths()): ProductConfig {
  if (!existsSync(paths.configFile)) {
    throw new Error(`Product configuration not found at ${paths.configFile}. Run setup first.`);
  }
  return parseArk(
    productConfigJsonType,
    readFileSync(paths.configFile, "utf8"),
    "product configuration",
  );
}

export function readProductSecrets(paths = productPaths()): ProductSecrets {
  if (!existsSync(paths.secretsFile)) {
    throw new Error(`Product secrets not found at ${paths.secretsFile}. Run setup first.`);
  }
  const mode = statSync(paths.secretsFile).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${paths.secretsFile} must have permissions 0600`);
  }
  return parseArk(
    secretsType,
    parseEnv(readFileSync(paths.secretsFile, "utf8")),
    "product secrets",
  );
}

export function effectiveCodexHome(configuredHome: string | undefined): string | undefined {
  if (configuredHome === undefined) {
    return undefined;
  }
  return path.resolve(configuredHome);
}

export function loadProduct(paths = productPaths()): LoadedProduct {
  const config = readProductConfig(paths);
  const secrets = readProductSecrets(paths);
  const codexHome = effectiveCodexHome(config.codex.home);
  return {
    bridge: {
      allowedChannelIds: new Set(config.slack.allowedChannelIds),
      allowedTeamId: config.slack.allowedTeamId,
      allowedUserId: config.slack.allowedUserId,
      appToken: secrets.SLACK_APP_TOKEN,
      botToken: secrets.SLACK_BOT_TOKEN,
      databasePath: paths.databaseFile,
      logLevel: config.runtime.logLevel,
      maxSlackResponseChars: config.runtime.maxSlackResponseChars,
      workspaces: config.workspaces,
      ...(codexHome === undefined ? {} : { codexHome }),
      ...(config.runtime.defaultWorkspaceAlias === undefined
        ? {}
        : { defaultWorkspaceAlias: config.runtime.defaultWorkspaceAlias }),
      ...(config.slack.allowedEnterpriseId === undefined
        ? {}
        : { allowedEnterpriseId: config.slack.allowedEnterpriseId }),
    },
    config,
    paths,
    secrets,
  };
}
