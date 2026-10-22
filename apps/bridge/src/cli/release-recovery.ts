import { redactSensitiveText } from "../slack/redact-sensitive.js";

function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown failure";
  return redactSensitiveText(error.message).slice(0, 2_000);
}

export function recoverFailedActivation(error: unknown, recover: () => void): never {
  try {
    recover();
  } catch (recoveryError) {
    throw new Error(
      `Activation failed: ${failureMessage(error)}. Automatic recovery failed: ${failureMessage(recoveryError)}. Intake remains drained; preserve the selected release and repair forward.`,
      { cause: new AggregateError([error, recoveryError], "Activation and recovery failed") },
    );
  }
  throw error;
}
