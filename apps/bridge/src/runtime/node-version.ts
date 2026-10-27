export function isSupportedNodeVersion(version: string): boolean {
  const components = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (components === null) return false;
  const major = Number(components[1]);
  const minor = Number(components[2]);
  const patch = Number(components[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (major === 22) return minor >= 14;
  if (major === 23) return minor >= 6;
  return major >= 24;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (!isSupportedNodeVersion(version))
    throw new Error(
      `Node ${version} is unsupported. Sam Bot requires Node 22.14+ in the 22.x line or Node 23.6 and newer; SQLite requires Node-API 10.`,
    );
}
