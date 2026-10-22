import { WebClient } from "@slack/web-api";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSlackApp,
  type SlackAppDependencies,
  type AuthorizedSlackReceipt,
} from "../src/slack/app.js";

interface EventInput {
  body: unknown;
  event: unknown;
  client: WebClient;
  context: { botUserId: string };
}

const captured = vi.hoisted(() => ({
  events: new Map<string, (input: EventInput) => Promise<void>>(),
}));

vi.mock("@slack/bolt", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeReceiver: class {
    client = { on: () => {}, removeListener: () => {}, disconnect: async () => {} };
    init() {}
    async start() {}
  },
  App: class {
    event(name: string, handler: (input: EventInput) => Promise<void>) {
      captured.events.set(name, handler);
    }
    action() {}
  },
}));

beforeEach(() => captured.events.clear());
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(parseCommand?: SlackAppDependencies["parseCommand"]) {
  const events = new Set<string>();
  const messages = new Set<string>();
  const store = {
    claimEvent(eventId: string): boolean {
      if (events.has(eventId)) return false;
      events.add(eventId);
      return true;
    },
    claimMessage(channelId: string, messageTs: string): boolean {
      const id = JSON.stringify([channelId, messageTs]);
      if (messages.has(id)) return false;
      messages.add(id);
      return true;
    },
    findTrackedRun: () => undefined,
  };
  const client = new WebClient("xoxb-synthetic");
  vi.spyOn(client, "apiCall").mockRejectedValue(new Error("Unexpected external call"));
  vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({ ok: true });
  vi.spyOn(client.chat, "postMessage").mockResolvedValue({ ok: true, ts: "123.456" });
  vi.spyOn(client.reactions, "add").mockResolvedValue({ ok: true });
  vi.spyOn(client.reactions, "remove").mockResolvedValue({ ok: true });
  const service = {
    handleMention: vi.fn(async () => {}),
    handleApproval: vi.fn(async () => {}),
    handleStopRun: vi.fn(async () => {}),
    handleNewSession: vi.fn(async () => {}),
  };
  const onAuthorizedReceipt = vi.fn<(receipt: AuthorizedSlackReceipt) => void | Promise<void>>();
  createSlackApp(
    {
      appToken: "xapp-synthetic",
      botToken: "xoxb-synthetic",
      allowedTeamId: "T_TEST",
      allowedUserId: "U_TEST",
      allowedChannelIds: new Set(["C_TEST"]),
      workspaces: { demo: "/private/tmp" },
      databasePath: ":memory:",
      logLevel: "silent",
      maxSlackResponseChars: 3_500,
    },
    {
      store,
      service,
      logger: pino({ level: "silent" }),
      onAuthorizedReceipt,
      ...(parseCommand === undefined ? {} : { parseCommand }),
    },
  );
  const dispatch = async (name: string, eventId: string, event: unknown, teamId = "T_TEST") => {
    const handler = captured.events.get(name);
    if (handler === undefined) throw new Error("Expected a registered Slack intake handler");
    await handler({
      body: { event_id: eventId, team_id: teamId },
      event,
      client,
      context: { botUserId: "U123BOT" },
    });
  };
  return { store, client, service, onAuthorizedReceipt, dispatch };
}

function event(direct = false) {
  return {
    channel: direct ? "D_TEST" : "C_TEST",
    ...(direct ? { channel_type: "im" } : {}),
    user: "U_TEST",
    text: "status",
    ts: "123.456",
  };
}

describe("authorized Slack health intake", () => {
  it.each([
    ["<@U123BOT> stop", "stop"],
    [
      "<@U123BOT> Ask <@U456OTHER> to stop\nKeep this text.",
      "Ask <@U456OTHER> to stop\nKeep this text.",
    ],
    ["<@U456OTHER> stop", "<@U456OTHER> stop"],
    ["Quote <@U123BOT> stop", "Quote <@U123BOT> stop"],
  ])("normalizes only this bot's leading direct-message address: %s", async (text, prompt) => {
    const value = fixture((request) => ({ type: "prompt", prompt: request }));
    await value.dispatch("message", "native-dm", { ...event(true), text });
    expect(value.service.handleMention).toHaveBeenCalledWith(
      expect.objectContaining({ directMessage: true, command: { type: "prompt", prompt } }),
    );
  });

  it.each([false, true])("observes an authorized newly claimed %s event once", async (direct) => {
    const value = fixture();
    const name = direct ? "message" : "app_mention";
    await value.dispatch(name, "event-one", event(direct));
    await value.dispatch(name, "event-one", { ...event(direct), ts: "123.457" });
    await value.dispatch(name, "event-two", event(direct));
    expect(value.onAuthorizedReceipt).toHaveBeenCalledTimes(1);
    expect(value.onAuthorizedReceipt).toHaveBeenCalledWith({
      eventId: "event-one",
      receivedAt: expect.any(String),
    });
    expect(value.service.handleMention).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not observe unauthorized or malformed %s events", async (direct) => {
    const value = fixture();
    const name = direct ? "message" : "app_mention";
    await value.dispatch(name, "event-one", event(direct), "T_OTHER");
    await value.dispatch(name, "event-two", { ...event(direct), user: "U_OTHER" });
    await value.dispatch(name, "event-three", {
      channel: event(direct).channel,
      ...(direct ? { channel_type: "im" } : {}),
      user: "U_TEST",
    });
    expect(value.onAuthorizedReceipt).not.toHaveBeenCalled();
    expect(value.service.handleMention).not.toHaveBeenCalled();
  });

  it("does not observe edited mentions or bot direct messages", async () => {
    const value = fixture();
    await value.dispatch("app_mention", "edited-event", { ...event(), edited: { ts: "123.457" } });
    await value.dispatch("message", "bot-event", { ...event(true), bot_id: "B_TEST" });
    expect(value.onAuthorizedReceipt).not.toHaveBeenCalled();
  });

  it("does not mark receipt before the durable message claim succeeds", async () => {
    const value = fixture();
    vi.spyOn(value.store, "claimMessage").mockImplementation(() => {
      throw new Error("Synthetic durable write failure");
    });
    await expect(value.dispatch("app_mention", "event-one", event())).rejects.toThrow(
      "durable write failure",
    );
    expect(value.onAuthorizedReceipt).not.toHaveBeenCalled();
  });

  it.each(["synchronous", "asynchronous"])(
    "contains a %s observer failure and continues the accepted request",
    async (kind) => {
      const value = fixture();
      if (kind === "synchronous")
        value.onAuthorizedReceipt.mockImplementation(() => {
          throw new Error("Synthetic health observer failure");
        });
      else
        value.onAuthorizedReceipt.mockRejectedValue(new Error("Synthetic health observer failure"));
      await expect(value.dispatch("message", "event-one", event(true))).resolves.toBeUndefined();
      await Promise.resolve();
      expect(value.service.handleMention).toHaveBeenCalledTimes(1);
      expect(value.client.chat.postMessage).not.toHaveBeenCalled();
    },
  );
});
