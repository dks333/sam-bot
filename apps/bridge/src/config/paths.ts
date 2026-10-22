import os from "node:os";
import path from "node:path";

export interface ProductPaths {
  configFile: string;
  databaseFile: string;
  home: string;
  launchAgentFile: string;
  logsDirectory: string;
  secretsFile: string;
}

export function resolveProductHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.SLACK_CODEX_HOME?.trim();
  const candidate =
    configured === undefined || configured.length === 0 ? "~/.slack-codex" : configured;
  return path.resolve(candidate.replace(/^~(?=$|\/)/u, os.homedir()));
}

export function productPaths(home = resolveProductHome()): ProductPaths {
  const resolvedHome = path.resolve(home);
  return {
    configFile: path.join(resolvedHome, "config.json"),
    databaseFile: path.join(resolvedHome, "bridge.sqlite"),
    home: resolvedHome,
    launchAgentFile: path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      "com.local.codex-slack.plist",
    ),
    logsDirectory: path.join(resolvedHome, "logs"),
    secretsFile: path.join(resolvedHome, "secrets.env"),
  };
}
