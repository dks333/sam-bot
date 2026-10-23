const tokenPatterns: readonly RegExp[] = [
  /\b(?:xox[abprs]|xapp)-[A-Za-z0-9-]+/gu,
  /\bgh[opusr]_[A-Za-z0-9_]+/gu,
  /\bsk-[A-Za-z0-9_-]+/gu,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9._-]+/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
];

const privateKeyPattern =
  /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gu;
const bearerPattern =
  /\bBearer[ \t]+(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\[REDACTED\]|[A-Za-z0-9._~+/-]+=*)/giu;
const assignedSecretPattern =
  /(\b[A-Za-z0-9_.-]{0,128}(?:api[_-]?key|authorization|bearer|password|passwd|secret|token|(?:private|secret|signing|encryption)[_-]?key|access[_-]?key(?:[_-]?id)?)\b)(["'`]?)(\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\[REDACTED\]|["'`][^\r\n]*|[^,;\r\n}\])]+)/giu;

function redactText(
  text: string,
  sensitiveValues: readonly string[],
  remainingDepth: number,
): string {
  let redacted = text;
  for (const value of sensitiveValues) {
    redacted = redacted.split(value).join("[REDACTED]");
  }
  redacted = redacted.replace(privateKeyPattern, "[REDACTED]");
  for (const pattern of tokenPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  redacted = redacted.replace(bearerPattern, "Bearer [REDACTED]");
  if (remainingDepth > 0) {
    redacted = redacted.replace(/"(?:\\[\s\S]|[^"\\])*"/gu, (quoted: string) => {
      if (!quoted.includes("\\")) {
        return quoted;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(quoted);
      } catch {
        return quoted;
      }
      if (typeof decoded !== "string") {
        return quoted;
      }
      const sanitized = redactText(decoded, sensitiveValues, remainingDepth - 1);
      if (sanitized === decoded) {
        return quoted;
      }
      return JSON.stringify(sanitized);
    });
  }
  return redacted.replace(
    assignedSecretPattern,
    (_match: string, key: string, keyQuote: string, separator: string, value: string) => {
      let valueQuote = "";
      if (value.startsWith('"')) {
        valueQuote = '"';
      } else if (value.startsWith("'")) {
        valueQuote = "'";
      } else if (value.startsWith("`")) {
        valueQuote = "`";
      }
      return `${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
    },
  );
}

export function redactSensitiveText(text: string, sensitiveValues: readonly string[] = []): string {
  const values = [...new Set(sensitiveValues.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  return redactText(text, values, 4);
}
