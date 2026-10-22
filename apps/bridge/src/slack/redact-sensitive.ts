const tokenPatterns: readonly RegExp[] = [
  /\bxox[abprs]-[A-Za-z0-9-]+/gu,
  /\bgh[opusr]_[A-Za-z0-9_]+/gu,
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9._-]+/gu,
];

const assignedSecretPattern =
  /\b(api[_-]?key|authorization|bearer|password|passwd|secret|token)(\s*[:=]\s*)[^\s,;]+/giu;

export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const pattern of tokenPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted.replace(assignedSecretPattern, "$1$2[REDACTED]");
}
