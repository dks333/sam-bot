export type LogLevel = "debug" | "error" | "fatal" | "info" | "silent" | "trace" | "warn";

export interface BridgeConfig {
  allowedChannelIds: Set<string>;
  allowedEnterpriseId?: string;
  allowedTeamId: string;
  allowedUserId: string;
  appToken: string;
  botToken: string;
  codexHome?: string;
  databasePath: string;
  defaultWorkspaceAlias?: string;
  logLevel: LogLevel;
  maxSlackResponseChars: number;
  workspaces: Record<string, string>;
}
