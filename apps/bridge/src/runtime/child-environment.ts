const inheritedEnvironmentNames: readonly string[] = [
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];

export function codexChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const name of inheritedEnvironmentNames) {
    const value = environment[name];
    if (value !== undefined) {
      allowed[name] = value;
    }
  }
  return allowed;
}
