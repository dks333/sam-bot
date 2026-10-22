import os from "node:os";
import path from "node:path";

import type { ProductPaths } from "../config/paths.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchAgentPlist(
  paths: ProductPaths,
  nodeExecutable: string,
  bridgeEntryFile: string,
  workingDirectory: string,
  executablePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  homeDirectory = os.homedir(),
): string {
  const standardOutput = path.join(paths.logsDirectory, "launchd-output.log");
  const standardError = path.join(paths.logsDirectory, "bridge.error.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.codex-slack</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeExecutable)}</string>
    <string>${escapeXml(bridgeEntryFile)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homeDirectory)}</string>
    <key>SLACK_CODEX_HOME</key>
    <string>${escapeXml(paths.home)}</string>
    <key>PATH</key>
    <string>${escapeXml(executablePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(standardOutput)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(standardError)}</string>
</dict>
</plist>
`;
}
