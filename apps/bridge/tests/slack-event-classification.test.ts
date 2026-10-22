import { describe, expect, it } from "vitest";

import { isEditedMessageEvent } from "../src/slack/app.js";

describe("Slack event classification", () => {
  it("processes a newly posted app mention", () => {
    expect(
      isEditedMessageEvent({
        channel: "C_TEST",
        text: "<@U_BOT> investigate this",
        ts: "123.456",
        type: "app_mention",
        user: "U_TEST",
      }),
    ).toBe(false);
  });

  it("ignores an app mention retained by an edited message", () => {
    expect(
      isEditedMessageEvent({
        channel: "C_TEST",
        edited: { ts: "123.789", user: "U_TEST" },
        text: "<@U_BOT> investigate this updated request",
        ts: "123.456",
        type: "app_mention",
        user: "U_TEST",
      }),
    ).toBe(true);
  });

  it("ignores Slack's message-changed subtype envelope", () => {
    expect(
      isEditedMessageEvent({
        channel: "C_TEST",
        message: {
          text: "<@U_BOT> investigate this updated request",
          ts: "123.456",
          user: "U_TEST",
        },
        subtype: "message_changed",
        type: "message",
      }),
    ).toBe(true);
  });
});
