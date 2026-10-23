import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../src/slack/redact-sensitive.js";
import { BoundaryValidationError, redactValidationSummary } from "../src/validation/parse.js";

describe("Sensitive text redaction", () => {
  it.each([
    ["xoxb-synthetic-bot-value", "Slack bot"],
    ["xapp-1-synthetic-app-value", "Slack app"],
    ["ghp_synthetic_personal_value", "GitHub"],
    ["sk-synthetic-provider-value", "provider"],
    ["eyJsyntheticpayloadlong.payload.signature", "JWT"],
    ["AKIA0000000000000000", "AWS access key"],
    ["ASIA0000000000000000", "AWS temporary access key"],
  ])("redacts the complete %s credential (%s)", (credential) => {
    expect(redactSensitiveText(`before ${credential} after`)).toBe("before [REDACTED] after");
  });

  it.each([
    ['{"password":"synthetic pass phrase"}', '{"password":"[REDACTED]"}'],
    ['{"api_key" : "synthetic\\\" quoted value"}', '{"api_key" : "[REDACTED]"}'],
    ["{'client_secret': 'synthetic\\' quoted value'}", "{'client_secret': '[REDACTED]'}"],
    ["AWS_SECRET_ACCESS_KEY='synthetic secret value'", "AWS_SECRET_ACCESS_KEY='[REDACTED]'"],
    ["AWS_ACCESS_KEY_ID=synthetic-key-identifier", "AWS_ACCESS_KEY_ID=[REDACTED]"],
    ['{"secret_key":"synthetic signing value"}', '{"secret_key":"[REDACTED]"}'],
    ["refreshToken = synthetic-refresh-value", "refreshToken = [REDACTED]"],
    ["db.password: synthetic pass phrase", "db.password: [REDACTED]"],
    ["signing-secret=`synthetic secret value`", "signing-secret=`[REDACTED]`"],
    ['password="synthetic unfinished value', 'password="[REDACTED]"'],
    ['{"password":"first\nsecond"}', '{"password":"[REDACTED]"}'],
    ["password=synthetic-value; safe=true", "password=[REDACTED]; safe=true"],
    ['{"token":"synthetic","enabled":true}', '{"token":"[REDACTED]","enabled":true}'],
  ])("redacts assigned values with their complete quoting: %s", (input, output) => {
    expect(redactSensitiveText(input)).toBe(output);
  });

  it.each([
    "Bearer synthetic-credential+/=",
    "bEaReR\tsynthetic-credential.value",
    'Bearer "synthetic credential with spaces"',
    "Bearer 'synthetic credential with spaces'",
  ])("redacts standalone bearer credentials: %s", (input) => {
    expect(redactSensitiveText(input)).toBe("Bearer [REDACTED]");
  });

  it.each([
    "Authorization: Bearer synthetic-credential",
    '"authorization": "Bearer synthetic-credential"',
    "authorization='Bearer synthetic-credential'",
  ])("redacts bearer authorization assignments: %s", (input) => {
    const redacted = redactSensitiveText(input);
    expect(redacted).not.toContain("synthetic-credential");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("Bearer");
  });

  it.each(["PRIVATE KEY", "RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"])(
    "redacts complete multiline %s blocks",
    (label) => {
      const input = `before\n-----BEGIN ${label}-----\nsynthetic-first-line\nsynthetic-second-line\n-----END ${label}-----\nafter`;
      expect(redactSensitiveText(input)).toBe("before\n[REDACTED]\nafter");
    },
  );

  it("redacts an unfinished private key block through the end of the text", () => {
    expect(redactSensitiveText("before\n-----BEGIN PRIVATE KEY-----\nsynthetic-first-line")).toBe(
      "before\n[REDACTED]",
    );
  });

  it("redacts configured exact secrets before matching formats without mutating the inputs", () => {
    const values = ["synthetic.+$credential", "synthetic.+$credential-long", ""];
    expect(
      redactSensitiveText(
        "synthetic.+$credential-long / synthetic.+$credential / synthetic.+$credential",
        values,
      ),
    ).toBe("[REDACTED] / [REDACTED] / [REDACTED]");
    expect(values).toEqual(["synthetic.+$credential", "synthetic.+$credential-long", ""]);
    expect(redactSensitiveText("synthetic.+$credential")).toBe("synthetic.+$credential");
  });

  it("keeps repeated calls and repeated redaction deterministic", () => {
    const input = '{"password":"synthetic password","app":"xapp-1-synthetic-value"}';
    const redacted = redactSensitiveText(input);
    expect(redactSensitiveText(input)).toBe(redacted);
    expect(redactSensitiveText(redacted)).toBe(redacted);
  });

  it("redacts labelled secrets in JSON-encoded command arguments", () => {
    const input = JSON.stringify({
      command: 'printf \'{"password":"synthetic quoted password"}\'',
    });
    const redacted = redactSensitiveText(input);
    expect(redacted).not.toContain("synthetic quoted password");
    expect(JSON.parse(redacted)).toEqual({
      command: 'printf \'{"password":"[REDACTED]"}\'',
    });
  });

  it("redacts exact configured values inside escaped JSON strings", () => {
    const credential = 'synthetic "quoted" credential';
    const input = JSON.stringify({ result: credential });
    expect(redactSensitiveText(input, [credential])).toBe('{"result":"[REDACTED]"}');
  });

  it("redacts labelled secrets through nested JSON string encoding", () => {
    let input = '{"api_key":"synthetic nested value"}';
    for (let depth = 0; depth < 3; depth += 1) {
      input = JSON.stringify({ content: input });
    }
    expect(redactSensitiveText(input)).not.toContain("synthetic nested value");
    expect(redactSensitiveText(redactSensitiveText(input))).toBe(redactSensitiveText(input));
  });

  it.each([
    "The password is requested through the native approval flow.",
    '{"enabled":true,"tokenCount":4,"passwordRequired":false}',
    "AWS_ACCESS_KEY_ID is the name of an environment variable.",
    "before synthetic unlabelled private content after",
    "-----BEGIN CERTIFICATE-----\nsynthetic-public-certificate\n-----END CERTIFICATE-----",
    "Use the secret manager to rotate credentials.",
    '{"command":"printf \\"safe value\\"","path":"synthetic\\\\example"}',
  ])("preserves benign text and does not claim arbitrary content detection: %s", (input) => {
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("uses the same policy for validation summaries and errors", () => {
    const input = 'expected a user id (was "xapp-1-synthetic-value")';
    const error = new BoundaryValidationError("synthetic boundary", input);
    expect(redactValidationSummary(input)).toBe('expected a user id (was "[REDACTED]")');
    expect(error.message).not.toContain("xapp-1-synthetic-value");
    expect(error.summary).not.toContain("xapp-1-synthetic-value");
    expect(error.boundary).toBe("synthetic boundary");
  });
});
