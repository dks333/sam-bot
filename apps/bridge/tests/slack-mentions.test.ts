import { describe, expect, it } from "vitest";

import {
  parseMention,
  removeAddressedBotMention,
  removeBotMention,
} from "../src/slack/mentions.js";

describe("native Slack mention intake", () => {
  it("removes the bot token while preserving the message content", () => {
    expect(removeBotMention("<@U123BOT> Inspect the synthetic module", "U123BOT")).toBe(
      "Inspect the synthetic module",
    );
  });

  it("preserves other users mentioned in channel requests", () => {
    expect(removeBotMention("<@U123BOT> Ask <@U456OTHER> to review this", "U123BOT")).toBe(
      "Ask <@U456OTHER> to review this",
    );
    expect(removeBotMention("Ask <@U456OTHER> and <@U123BOT> to review this", "U123BOT")).toBe(
      "Ask <@U456OTHER> and  to review this",
    );
    expect(removeBotMention("<@U123BOT> stop")).toBe("<@U123BOT> stop");
  });

  it("removes only a leading mention addressed to this bot", () => {
    expect(removeAddressedBotMention("  <@U123BOT> stop", "U123BOT")).toBe("stop");
    expect(
      removeAddressedBotMention("<@U123BOT> Ask <@U456OTHER>\n  Keep spacing  ", "U123BOT"),
    ).toBe("Ask <@U456OTHER>\n  Keep spacing  ");
    expect(removeAddressedBotMention("<@U456OTHER> stop", "U123BOT")).toBe("<@U456OTHER> stop");
    expect(removeAddressedBotMention("Quote <@U123BOT> stop", "U123BOT")).toBe(
      "Quote <@U123BOT> stop",
    );
    expect(removeAddressedBotMention("<@U123BOT> stop")).toBe("<@U123BOT> stop");
  });

  it.each([
    "new synthetic-workspace inspect the module",
    "continue synthetic-session run the checks",
    "profile use synthetic-profile",
    "route status",
    "stop rejecting requests",
    "hello\ninspect the module",
    "status",
    "",
  ])("passes %j unchanged to the native conversation service", (text) => {
    expect(parseMention(text)).toEqual({ type: "prompt", prompt: text });
  });
});
