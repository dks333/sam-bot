import { ArkErrors } from "arktype";

import { redactSensitiveText } from "../slack/redact-sensitive.js";

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

export function redactValidationSummary(summary: string): string {
  return redactSensitiveText(summary);
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
