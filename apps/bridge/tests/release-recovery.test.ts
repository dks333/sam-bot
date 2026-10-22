import { describe, expect, it, vi } from "vitest";

import { recoverFailedActivation } from "../src/cli/release-recovery.js";

describe("failed activation recovery reporting", () => {
  it("preserves the original failure after successful recovery", () => {
    const failure = new Error("Synthetic native initialization deadline");
    const recover = vi.fn();
    expect(() => recoverFailedActivation(failure, recover)).toThrow(failure);
    expect(recover).toHaveBeenCalledOnce();
  });

  it("retains both failures when schema compatibility prevents recovery", () => {
    const failure = new Error("Synthetic native initialization deadline");
    const refusal = new Error("Synthetic previous release cannot read current database schema");
    const restore = vi.fn(() => {
      throw refusal;
    });
    const bootstrap = vi.fn();
    let result: unknown;
    try {
      recoverFailedActivation(failure, () => {
        restore();
        bootstrap();
      });
    } catch (error) {
      result = error;
    }
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error) || !(result.cause instanceof AggregateError))
      throw new Error("Expected both activation and recovery causes");
    expect(result.message).toContain("Synthetic native initialization deadline");
    expect(result.message).toContain(
      "Synthetic previous release cannot read current database schema",
    );
    expect(result.message).toContain("Intake remains drained");
    expect(result.cause.errors).toEqual([failure, refusal]);
    expect(restore).toHaveBeenCalledOnce();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("bounds and redacts the displayed failures while retaining their causes", () => {
    const failure = new Error(`token=synthetic-private-value ${"x".repeat(4_000)}`);
    const refusal = new Error("password=synthetic-private-password");
    let message = "";
    try {
      recoverFailedActivation(failure, () => {
        throw refusal;
      });
    } catch (error) {
      if (error instanceof Error) message = error.message;
    }
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("synthetic-private-value");
    expect(message).not.toContain("synthetic-private-password");
    expect(message.length).toBeLessThan(4_200);
  });
});
