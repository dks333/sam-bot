import { createHash } from "node:crypto";

import type { WebClient } from "@slack/web-api";

import { NativeFinalNotSentError } from "../bridge/native-final-delivery.js";
import type {
  NativeDelivery,
  NativeFinalIdentity,
  NativeFinalReconciliation,
} from "../persistence/native-conversation-store.js";
import { WebApiSlackResponder, slackMrkdwn, type SlackResponder } from "./responder.js";
import { redactSensitiveText } from "./redact-sensitive.js";

export interface NativeSlackTransport {
  setMessageStatus: SlackResponder["setMessageStatus"];
  post(delivery: NativeDelivery, text: string, part: number, working?: boolean): Promise<string>;
  postFinal(delivery: NativeDelivery, text: string, identity: NativeFinalIdentity): Promise<string>;
  reconcile(
    delivery: NativeDelivery,
    identity: NativeFinalIdentity,
  ): Promise<NativeFinalReconciliation>;
  update(delivery: NativeDelivery, receipt: string, text: string, working?: boolean): Promise<void>;
  approval(input: {
    approvalId: string;
    expiresAt: string;
    summary: string;
    userId: string;
    channelId: string;
    threadTs: string;
  }): Promise<void>;
  info(input: { channelId: string; threadTs: string; text: string }): Promise<void>;
  privateInfo(input: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clientMessageId(eventId: string, part: number): string {
  const hex = createHash("sha256").update(`${eventId}:${part}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function provenNotSent(error: unknown): never {
  if (
    isRecord(error) &&
    error.code === "slack_webapi_platform_error" &&
    isRecord(error.data) &&
    typeof error.data.error === "string" &&
    [
      "channel_not_found",
      "not_in_channel",
      "missing_scope",
      "invalid_auth",
      "not_authed",
      "token_revoked",
      "token_expired",
      "account_inactive",
      "is_archived",
      "no_permission",
    ].includes(error.data.error)
  )
    throw new NativeFinalNotSentError("Slack rejected final delivery before sending", 30_000);
  if (
    isRecord(error) &&
    error.code === "slack_webapi_rate_limited_error" &&
    typeof error.retryAfter === "number" &&
    Number.isFinite(error.retryAfter) &&
    error.retryAfter >= 0 &&
    error.retryAfter <= Number.MAX_SAFE_INTEGER / 1_000
  )
    throw new NativeFinalNotSentError(
      "Slack rate limited the final delivery",
      error.retryAfter * 1_000,
    );
  throw error;
}

export function nativeSlackTransport(
  client: WebClient,
  redactText: (text: string) => string = redactSensitiveText,
): NativeSlackTransport {
  const responder = new WebApiSlackResponder(client, 39_000, redactText);
  let botIdentity: Promise<{ userId: string; botId: string; teamId: string }> | undefined;
  async function ownIdentity() {
    if (botIdentity === undefined) {
      botIdentity = client.auth
        .test()
        .then((response) => {
          if (
            response.ok !== true ||
            typeof response.user_id !== "string" ||
            typeof response.bot_id !== "string" ||
            typeof response.team_id !== "string"
          )
            throw new Error("Slack did not confirm the bot identity");
          return { userId: response.user_id, botId: response.bot_id, teamId: response.team_id };
        })
        .catch((error: unknown) => {
          botIdentity = undefined;
          throw error;
        });
    }
    return botIdentity;
  }
  async function post(delivery: NativeDelivery, text: string, id: string): Promise<string> {
    const arguments_ = {
      channel: delivery.channelId,
      thread_ts: delivery.threadTs,
      text: slackMrkdwn(redactText(text)),
      blocks: [],
      client_msg_id: id,
    };
    const response = await client.chat.postMessage(arguments_);
    if (response.ok === false)
      provenNotSent({ code: "slack_webapi_platform_error", data: response });
    if (
      response.ok !== true ||
      typeof response.ts !== "string" ||
      !/^\d+\.\d+$/u.test(response.ts) ||
      (response.channel !== undefined && response.channel !== delivery.channelId)
    )
      throw new Error("Slack did not confirm the native response receipt");
    return response.ts;
  }
  return {
    async setMessageStatus(reference, status, previousStatus) {
      await responder.setMessageStatus(reference, status, previousStatus);
    },
    async post(delivery, text, part) {
      return post(delivery, text, clientMessageId(delivery.eventId, part));
    },
    async postFinal(delivery, text, identity) {
      try {
        return await post(delivery, text, identity.id);
      } catch (error) {
        return provenNotSent(error);
      }
    },
    async reconcile(delivery, identity) {
      const own = await ownIdentity();
      if (own.teamId !== delivery.teamId) return { status: "unknown", reason: "team_mismatch" };
      let cursor: string | undefined;
      const cursors = new Set<string>();
      const matches = new Set<string>();
      for (let page = 0; page < 10; page += 1) {
        const response: unknown = await client.conversations.replies({
          channel: delivery.channelId,
          ts: delivery.threadTs,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!isRecord(response) || response.ok !== true || !Array.isArray(response.messages))
          return { status: "unknown", reason: "invalid_history" };
        for (const message of response.messages) {
          if (!isRecord(message) || message.client_msg_id !== identity.id) continue;
          if (
            message.user !== own.userId ||
            message.bot_id !== own.botId ||
            message.thread_ts !== delivery.threadTs ||
            typeof message.ts !== "string" ||
            !/^\d+\.\d+$/u.test(message.ts)
          )
            return { status: "unknown", reason: "identity_mismatch" };
          matches.add(message.ts);
        }
        if (matches.size > 1) return { status: "unknown", reason: "duplicate_identity" };
        const metadata = response.response_metadata;
        const next = isRecord(metadata) ? metadata.next_cursor : undefined;
        if (next !== undefined && typeof next !== "string")
          return { status: "unknown", reason: "invalid_cursor" };
        if (typeof next !== "string" || next.length === 0) {
          if (response.has_more === true)
            return { status: "unknown", reason: "incomplete_history" };
          const messageTs = [...matches][0];
          if (messageTs !== undefined) return { status: "found", messageTs };
          return { status: "unknown", reason: "receipt_not_proven" };
        }
        if (cursors.has(next)) return { status: "unknown", reason: "repeated_cursor" };
        cursors.add(next);
        cursor = next;
      }
      return { status: "unknown", reason: "history_limit" };
    },
    async update(delivery, receipt, text) {
      try {
        const response = await client.chat.update({
          channel: delivery.channelId,
          ts: receipt,
          text: slackMrkdwn(redactText(text)),
          blocks: [],
        });
        if (
          response.ok !== true ||
          response.ts !== receipt ||
          (response.channel !== undefined && response.channel !== delivery.channelId)
        )
          throw new Error("Slack did not confirm the native response update");
      } catch (error) {
        provenNotSent(error);
      }
    },
    async approval(input) {
      await responder.postApproval({ channelId: input.channelId, threadTs: input.threadTs }, input);
    },
    async info(input) {
      await responder.postInfo(
        { channelId: input.channelId, threadTs: input.threadTs },
        input.text,
      );
    },
    async privateInfo(input) {
      await responder.postPrivateInfo(
        { channelId: input.channelId, threadTs: input.threadTs },
        input.userId,
        input.text,
      );
    },
  };
}
