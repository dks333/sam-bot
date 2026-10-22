import { describe, expect, it } from "vitest";

import { loadSlackThreadContext } from "../src/slack/thread-context.js";

describe("Slack thread context", () => {
  it("loads parent and prior replies, including forwarded attachment content", async () => {
    const calls: unknown[] = [];
    const context = await loadSlackThreadContext({
      allowedChannelIds: new Set(["C1"]),
      channelId: "C1",
      currentMessageTs: "10.3",
      fetchReplies: async (input) => {
        calls.push(input);
        return {
          messages: [
            {
              attachments: [
                {
                  fallback: "Forwarded message from Lauren",
                  from_url: "https://example.slack.com/archives/C2/p100",
                  message_blocks: [
                    {
                      message: {
                        text: "Customer reports crossed custom llms.txt routes.",
                      },
                    },
                  ],
                },
              ],
              text: "",
              ts: "10.0",
              user: "U_PARENT",
            },
            {
              blocks: [
                {
                  elements: [{ elements: [{ text: "Earlier reply with useful context." }] }],
                },
              ],
              ts: "10.2",
              user: "U_REPLY",
            },
            {
              text: "Investigate this thread",
              ts: "10.3",
              user: "U_CURRENT",
            },
            {
              text: "A later message must not leak into this run",
              ts: "10.4",
              user: "U_FUTURE",
            },
          ],
        };
      },
      threadTs: "10.0",
    });

    expect(calls).toEqual([{ channel: "C1", limit: 100, ts: "10.0" }]);
    expect(context).toContain("Parent from U_PARENT at 10.0");
    expect(context).toContain("Forwarded message from Lauren");
    expect(context).toContain("Customer reports crossed custom llms.txt routes.");
    expect(context).toContain("Earlier reply with useful context.");
    expect(context).not.toContain("Investigate this thread");
    expect(context).not.toContain("later message");
  });

  it("dereferences an allowlisted forwarded Slack thread", async () => {
    const calls: unknown[] = [];
    const context = await loadSlackThreadContext({
      allowedChannelIds: new Set(["C1", "C2"]),
      channelId: "C1",
      currentMessageTs: "1787766806.912299",
      fetchReplies: async (input) => {
        calls.push(input);
        if (input.channel === "C2") {
          return {
            messages: [
              {
                text: "Allan's intro",
                ts: "1787748319.117409",
                user: "U_ALLAN",
              },
              {
                text: "Self-hosted videos do not load in Safari.",
                ts: "1787748347.897029",
                user: "U_ALLAN",
              },
            ],
          };
        }
        return {
          messages: [
            {
              attachments: [
                {
                  fallback: "Forwarded message from Allan",
                  from_url:
                    "https://example.slack.com/archives/C2/p1787748319117409?thread_ts=1787748319.117409&cid=C2",
                  message_blocks: [{ message: { text: "Allan's intro" } }],
                },
              ],
              text: "",
              ts: "1787748740.951739",
              user: "U_PARENT",
            },
            {
              text: "mind taking a look?",
              ts: "1787766806.912299",
              user: "U_CURRENT",
            },
          ],
        };
      },
      threadTs: "1787748740.951739",
    });

    expect(calls).toEqual([
      { channel: "C1", limit: 100, ts: "1787748740.951739" },
      { channel: "C2", limit: 100, ts: "1787748319.117409" },
    ]);
    expect(context).toContain("Forwarded Slack thread C2 at 1787748319.117409");
    expect(context).toContain("Self-hosted videos do not load in Safari.");
    expect(context).not.toContain("mind taking a look?");
  });

  it("does not dereference a forwarded thread outside the channel allowlist", async () => {
    const calls: unknown[] = [];
    const context = await loadSlackThreadContext({
      allowedChannelIds: new Set(["C1"]),
      channelId: "C1",
      currentMessageTs: "20.2",
      fetchReplies: async (input) => {
        calls.push(input);
        return {
          messages: [
            {
              attachments: [
                {
                  from_url:
                    "https://example.slack.com/archives/C2/p1000000000000000?thread_ts=10.000000&cid=C2",
                  text: "Forwarded parent only",
                },
              ],
              ts: "20.0",
              user: "U_PARENT",
            },
          ],
        };
      },
      threadTs: "20.0",
    });

    expect(calls).toEqual([{ channel: "C1", limit: 100, ts: "20.0" }]);
    expect(context).toContain("source channel is not allowlisted");
  });

  it("dereferences a forwarded thread under the workspace-wide channel policy", async () => {
    const calls: unknown[] = [];
    const context = await loadSlackThreadContext({
      allowedChannelIds: new Set(["*"]),
      channelId: "C1",
      currentMessageTs: "20.2",
      fetchReplies: async (input) => {
        calls.push(input);
        if (input.channel === "C2") {
          return {
            messages: [{ text: "Forwarded details", ts: "10.0", user: "U_FORWARDED" }],
          };
        }
        return {
          messages: [
            {
              attachments: [
                {
                  from_url:
                    "https://example.slack.com/archives/C2/p1000000000000000?thread_ts=10.000000&cid=C2",
                  text: "Forwarded parent only",
                },
              ],
              ts: "20.0",
              user: "U_PARENT",
            },
          ],
        };
      },
      threadTs: "20.0",
    });

    expect(calls).toEqual([
      { channel: "C1", limit: 100, ts: "20.0" },
      { channel: "C2", limit: 100, ts: "10.000000" },
    ]);
    expect(context).toContain("Forwarded details");
  });

  it("keeps outer context when the bot cannot read an allowlisted forwarded thread", async () => {
    const errors: unknown[] = [];
    const context = await loadSlackThreadContext({
      allowedChannelIds: new Set(["C1", "C2"]),
      channelId: "C1",
      currentMessageTs: "20.2",
      fetchReplies: async (input) => {
        if (input.channel === "C2") {
          throw new Error("not_in_channel");
        }
        return {
          messages: [
            {
              attachments: [
                {
                  from_url:
                    "https://example.slack.com/archives/C2/p1000000000000000?thread_ts=10.000000&cid=C2",
                  text: "Forwarded parent only",
                },
              ],
              ts: "20.0",
              user: "U_PARENT",
            },
          ],
        };
      },
      onForwardedThreadError: (reference, error) => errors.push({ error, reference }),
      threadTs: "20.0",
    });

    expect(errors).toHaveLength(1);
    expect(context).toContain("Forwarded parent only");
    expect(context).toContain("could not be read by the Slack bot");
  });

  it("does not fetch context for a root message", async () => {
    let called = false;
    const context = await loadSlackThreadContext({
      allowedChannelIds: new Set(["C1"]),
      channelId: "C1",
      currentMessageTs: "10.0",
      fetchReplies: async () => {
        called = true;
        return { messages: [] };
      },
      threadTs: "10.0",
    });

    expect(called).toBe(false);
    expect(context).toBeUndefined();
  });
});
