import { ArkErrors } from "arktype";

export interface ArkParser<Output> {
  (input: unknown): ArkErrors | Output;
}

export class BoundaryValidationError extends Error {
  readonly boundary: string;
  readonly summary: string;

  constructor(boundary: string, summary: string) {
    super(`${boundary} is invalid: ${redactValidationSummary(summary)}`);
    this.name = "BoundaryValidationError";
    this.boundary = boundary;
    this.summary = redactValidationSummary(summary);
  }
}

export type ValidationResult<Output> =
  | {
      error: BoundaryValidationError;
      ok: false;
    }
  | {
      ok: true;
      value: Output;
    };

const secretPatterns = [
  /\bxox[baprs]-[A-Za-z0-9-]+\b/gu,
  /\bsk-[A-Za-z0-9_-]+\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
];

export function redactValidationSummary(summary: string): string {
  let redacted = summary;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

export function parseArk<Output>(
  schema: ArkParser<Output>,
  input: unknown,
  boundary: string,
): Output {
  const result = schema(input);
  if (result instanceof ArkErrors) {
    throw new BoundaryValidationError(boundary, result.summary);
  }
  return result;
}

export function tryParseArk<Output>(
  schema: ArkParser<Output>,
  input: unknown,
  boundary: string,
): ValidationResult<Output> {
  const result = schema(input);
  if (result instanceof ArkErrors) {
    return {
      error: new BoundaryValidationError(boundary, result.summary),
      ok: false,
    };
  }
  return { ok: true, value: result };
}
