import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import { redactLocalPaths } from "./redact-local-paths.js";
import { redactSensitiveText } from "./redact-sensitive.js";

export interface SlackReplyContext {
  channelId: string;
  threadTs: string;
}

export interface SlackMessageReference {
  channelId: string;
  messageTs: string;
}

export type SlackMessageStatus =
  | "acknowledged"
  | "completed"
  | "failed"
  | "stopped"
  | "waiting"
  | "working";

export interface SlackResponder {
  postApproval(
    context: SlackReplyContext,
    input: {
      approvalId: string;
      expiresAt: string;
      summary: string;
      userId: string;
    },
  ): Promise<void>;
  postError(context: SlackReplyContext, message: string): Promise<void>;
  postInfo(context: SlackReplyContext, message: string): Promise<void>;
  postPrivateError(context: SlackReplyContext, userId: string, message: string): Promise<void>;
  postPrivateInfo(context: SlackReplyContext, userId: string, message: string): Promise<void>;
  setMessageStatus(
    reference: SlackMessageReference,
    status: SlackMessageStatus,
    previousStatus?: SlackMessageStatus,
  ): Promise<void>;
}

const reactionByStatus: Record<SlackMessageStatus, string> = {
  acknowledged: "eyes",
  completed: "white_check_mark",
  failed: "x",
  stopped: "octagonal_sign",
  waiting: "raised_hand",
  working: "eyes",
};

function isSlackReactionError(error: unknown, expected: string): boolean {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return false;
  }
  const data = error.data;
  return typeof data === "object" && data !== null && "error" in data && data.error === expected;
}

function truncate(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }

  const suffix = "\n\n…Message truncated to fit Slack.";
  return `${text.slice(0, maxCharacters - suffix.length)}${suffix}`;
}

function containsHiddenCharacters(text: string): boolean {
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return true;
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
  });
}

function safeSlackText(text: string, redact: (text: string) => string): string {
  return redactLocalPaths(redact(text));
}

function transformMarkdownText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/gu, "*$1*")
    .replace(/__([^_\n]+)__/gu, "*$1*");
}

export function slackMrkdwn(markdown: string): string {
  let inCodeFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) {
        return line;
      }

      const heading = /^(?:#{1,6})\s+(.+)$/u.exec(line);
      const normalizedLine =
        heading === null ? line.replace(/^(\s*)[-*]\s+/u, "$1• ") : `*${heading[1] ?? ""}*`;
      return normalizedLine
        .split(/(`[^`\n]*`)/u)
        .map((segment, index) => (index % 2 === 0 ? transformMarkdownText(segment) : segment))
        .join("");
    })
    .join("\n");
}

export class WebApiSlackResponder implements SlackResponder {
  readonly #client: WebClient;
  readonly #maxCharacters: number;
  readonly #redact: (text: string) => string;

  constructor(
    client: WebClient,
    maxCharacters: number,
    redact: (text: string) => string = redactSensitiveText,
  ) {
    this.#client = client;
    this.#maxCharacters = maxCharacters;
    this.#redact = redact;
  }

  async postApproval(
    context: SlackReplyContext,
    input: {
      approvalId: string;
      expiresAt: string;
      summary: string;
      userId: string;
    },
  ): Promise<void> {
    if (
      input.summary.length > 2_700 ||
      this.#redact(input.summary) !== input.summary ||
      containsHiddenCharacters(input.summary)
    ) {
      throw new Error(
        "Complete this approval locally; its full scope cannot be shown safely in Slack.",
      );
    }
    const blocks: KnownBlock[] = [
      {
        type: "section",
        text: {
          type: "plain_text",
          emoji: false,
          text: `Approval required\n\n${input.summary}\n\nExpires at ${input.expiresAt}.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            action_id: "bridge_approve_once",
            style: "primary",
            text: {
              type: "plain_text",
              text: "Approve once",
            },
            type: "button",
            value: input.approvalId,
          },
          {
            action_id: "bridge_deny",
            style: "danger",
            text: {
              type: "plain_text",
              text: "Deny",
            },
            type: "button",
            value: input.approvalId,
          },
        ],
      },
    ];

    await this.#client.chat.postEphemeral({
      blocks,
      channel: context.channelId,
      text: "Approval required. Review the complete action in the private approval card.",
      parse: "none",
      thread_ts: context.threadTs,
      user: input.userId,
    });
  }

  async postError(context: SlackReplyContext, message: string): Promise<void> {
    await this.#client.chat.postMessage({
      channel: context.channelId,
      text: truncate(safeSlackText(`❌ ${message}`, this.#redact), this.#maxCharacters),
      thread_ts: context.threadTs,
    });
  }

  async postInfo(context: SlackReplyContext, message: string): Promise<void> {
    await this.#client.chat.postMessage({
      channel: context.channelId,
      text: truncate(safeSlackText(message, this.#redact), this.#maxCharacters),
      thread_ts: context.threadTs,
    });
  }

  async postPrivateError(
    context: SlackReplyContext,
    userId: string,
    message: string,
  ): Promise<void> {
    await this.#client.chat.postEphemeral({
      channel: context.channelId,
      text: truncate(safeSlackText(`❌ ${message}`, this.#redact), this.#maxCharacters),
      thread_ts: context.threadTs,
      user: userId,
    });
  }

  async postPrivateInfo(
    context: SlackReplyContext,
    userId: string,
    message: string,
  ): Promise<void> {
    await this.#client.chat.postEphemeral({
      channel: context.channelId,
      text: truncate(safeSlackText(message, this.#redact), this.#maxCharacters),
      thread_ts: context.threadTs,
      user: userId,
    });
  }

  async setMessageStatus(
    reference: SlackMessageReference,
    status: SlackMessageStatus,
    previousStatus?: SlackMessageStatus,
  ): Promise<void> {
    if (status === previousStatus) {
      return;
    }

    const reaction = reactionByStatus[status];
    if (previousStatus !== undefined && reaction === reactionByStatus[previousStatus]) {
      return;
    }

    // Add the new state first so a partial Slack API failure never removes the only status.
    try {
      await this.#client.reactions.add({
        channel: reference.channelId,
        name: reaction,
        timestamp: reference.messageTs,
      });
    } catch (error) {
      if (!isSlackReactionError(error, "already_reacted")) {
        throw error;
      }
    }

    if (previousStatus === undefined) {
      return;
    }

    try {
      await this.#client.reactions.remove({
        channel: reference.channelId,
        name: reactionByStatus[previousStatus],
        timestamp: reference.messageTs,
      });
    } catch (error) {
      if (!isSlackReactionError(error, "no_reaction")) {
        throw error;
      }
    }
  }
}
