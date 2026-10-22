const redaction = "[local path]";

const localRoot = String.raw`(?:Users|home|Applications|Library|System|Volumes|private|tmp|var|opt|usr|bin|sbin|etc|dev)`;

// Root-limited patterns preserve web URLs and relative project paths while covering common
// POSIX, Windows, UNC, home-relative, quoted, and file-URL path forms.
const localPathPatterns = [
  /\bfile:\/\/\/[^\s<>{}[\]()]*/giu,
  /(["'`])\/(?:Users|home|Applications|Library|System|Volumes|private|tmp|var|opt|usr|bin|sbin|etc|dev)(?:\/[^"'`\r\n]*)?\1/gu,
  new RegExp(`(?<![A-Za-z0-9:/])/${localRoot}(?:/[^\\s\`"'<>|;&()\\[\\]{}]*)*`, "gu"),
  /(?<![A-Za-z0-9/])~\/[^\s`"'<>|;&()[\]{}]*/gu,
  /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/gu,
  /(?<!\\)\\\\[^\\\s]+\\[^\s`"'<>|;&()[\]{}]*/gu,
];

export function redactLocalPaths(text: string): string {
  return localPathPatterns.reduce(
    (safeText, pattern) => safeText.replace(pattern, redaction),
    text,
  );
}
