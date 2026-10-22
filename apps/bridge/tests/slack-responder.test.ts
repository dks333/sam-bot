import { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

import { WebApiSlackResponder } from "../src/slack/responder.js";

describe("Slack approval messages", () => {
  it("posts an approval card ephemerally to one user in the thread", async () => {
    const client = new WebClient("xoxb-test");
    const postEphemeral = vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({
      message_ts: "123.457",
      ok: true,
    });
    const postMessage = vi.spyOn(client.chat, "postMessage").mockResolvedValue({
      ok: true,
      ts: "123.457",
    });
    const responder = new WebApiSlackResponder(client, 3_500);

    await responder.postApproval(
      {
        channelId: "C1",
        threadTs: "123.456",
      },
      {
        approvalId: "approval-1",
        expiresAt: "2026-08-19T22:46:50.377Z",
        summary: "creating a pull request on an external service",
        userId: "U1",
      },
    );

    const payload = postEphemeral.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      channel: "C1",
      thread_ts: "123.456",
      user: "U1",
    });
    if (payload === undefined || !("blocks" in payload)) {
      throw new Error("Expected Block Kit approval payload");
    }
    const blocks = JSON.stringify(payload.blocks);
    expect(blocks).toContain("bridge_approve_once");
    expect(blocks).toContain("bridge_deny");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("posts approval acknowledgements ephemerally to one user", async () => {
    const client = new WebClient("xoxb-test");
    const postEphemeral = vi.spyOn(client.chat, "postEphemeral").mockResolvedValue({
      message_ts: "123.457",
      ok: true,
    });
    const responder = new WebApiSlackResponder(client, 3_500);
    const context = {
      channelId: "C1",
      threadTs: "123.456",
    };

    await responder.postPrivateInfo(context, "U1", "✅ Approved once.");
    await responder.postPrivateError(context, "U1", "Approval expired.");

    expect(postEphemeral.mock.calls).toEqual([
      [
        {
          channel: "C1",
          text: "✅ Approved once.",
          thread_ts: "123.456",
          user: "U1",
        },
      ],
      [
        {
          channel: "C1",
          text: "❌ Approval expired.",
          thread_ts: "123.456",
          user: "U1",
        },
      ],
    ]);
  });
});

describe("Slack message status reactions", () => {
  it("keeps the shared looking and working reaction before replacing it on completion", async () => {
    const client = new WebClient("xoxb-test");
    const addReaction = vi.spyOn(client.reactions, "add").mockResolvedValue({ ok: true });
    const removeReaction = vi.spyOn(client.reactions, "remove").mockResolvedValue({ ok: true });
    const responder = new WebApiSlackResponder(client, 3_500);
    const reference = {
      channelId: "C1",
      messageTs: "123.456",
    };

    await responder.setMessageStatus(reference, "acknowledged");
    await responder.setMessageStatus(reference, "working", "acknowledged");
    await responder.setMessageStatus(reference, "completed", "working");

    expect(addReaction.mock.calls).toEqual([
      [{ channel: "C1", name: "eyes", timestamp: "123.456" }],
      [{ channel: "C1", name: "white_check_mark", timestamp: "123.456" }],
    ]);
    expect(removeReaction.mock.calls).toEqual([
      [{ channel: "C1", name: "eyes", timestamp: "123.456" }],
    ]);
  });

  it("does not call Slack when the message already has the requested status", async () => {
    const client = new WebClient("xoxb-test");
    const addReaction = vi.spyOn(client.reactions, "add").mockResolvedValue({ ok: true });
    const removeReaction = vi.spyOn(client.reactions, "remove").mockResolvedValue({ ok: true });
    const responder = new WebApiSlackResponder(client, 3_500);

    await responder.setMessageStatus(
      {
        channelId: "D1",
        messageTs: "987.654",
      },
      "waiting",
      "waiting",
    );

    expect(addReaction).not.toHaveBeenCalled();
    expect(removeReaction).not.toHaveBeenCalled();
  });
});
