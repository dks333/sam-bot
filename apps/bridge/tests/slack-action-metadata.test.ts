import { describe, expect, it } from "vitest";

import { parseActionBody } from "../src/slack/app.js";

const identity = {
  team: { id: "T_TEST" },
  user: { id: "U_TEST" },
};

describe("Slack action metadata", () => {
  it("parses a normal message action", () => {
    expect(
      parseActionBody({
        ...identity,
        channel: { id: "C_TEST" },
        message: { thread_ts: "123.456", ts: "123.457" },
      }),
    ).toEqual({
      ...identity,
      channel: { id: "C_TEST" },
      message: { thread_ts: "123.456", ts: "123.457" },
    });
  });

  it("parses an ephemeral message action from its container", () => {
    expect(
      parseActionBody({
        ...identity,
        container: {
          channel_id: "C_TEST",
          is_ephemeral: true,
          message_ts: "123.457",
          thread_ts: "123.456",
          type: "message",
        },
      }),
    ).toEqual({
      ...identity,
      channel: { id: "C_TEST" },
      message: { thread_ts: "123.456", ts: "123.457" },
    });
  });

  it("rejects an action without a message location", () => {
    expect(parseActionBody(identity)).toBeUndefined();
  });
});
