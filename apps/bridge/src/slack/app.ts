import {
  App,
  LogLevel,
  SocketModeReceiver,
  type Logger as SlackSdkLogger,
  type Receiver,
} from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { type } from "arktype";
import type { Logger } from "pino";

import type { SlackService } from "../bridge/slack-service-contract.js";
import type { BridgeConfig } from "../config/env.js";
import { tryParseArk } from "../validation/parse.js";
import { authorizeSlackIdentity, type SlackIdentity } from "./authorize.js";
import { downloadSlackImages, parseSlackImages } from "./images.js";
import {
  parseMention,
  removeAddressedBotMention,
  removeBotMention,
  type MentionCommand,
} from "./mentions.js";
import {
  type SlackMessageReference,
  type SlackMessageStatus,
  type SlackResponder,
  WebApiSlackResponder,
} from "./responder.js";
import { loadSlackThreadContext } from "./thread-context.js";
import { redactSensitiveText } from "./redact-sensitive.js";
import {
  SlackConnectionLifecycle,
  slackRequestFetch,
  type SlackConnectionState,
} from "./connection-lifecycle.js";

export interface AuthorizedSlackReceipt {
  eventId: string;
  receivedAt: string;
}

export interface SlackEventStore {
  claimEvent(eventId: string, processedAt: string): boolean;
  claimMessage(channelId: string, messageTs: string, processedAt: string): boolean;
  findTrackedRun(
    eventId: string,
  ): { eventId: string; channelId: string; slackThreadTs: string } | undefined;
}

export interface SlackAppDependencies {
  parseCommand?: (text: string) => MentionCommand;
  logger: Logger;
  service: SlackService;
  store: SlackEventStore;
  onConnectionState?: (state: SlackConnectionState) => void | Promise<void>;
  slackFetch?: typeof globalThis.fetch;
  onAuthorizedReceipt?: (receipt: AuthorizedSlackReceipt) => void | Promise<void>;
}

const eventBodyMetadataType = type({
  "enterprise_id?": "string",
  event_id: "string",
  team_id: "string",
});

const mentionIdentityType = type({
  channel: "string",
  user: "string",
});

const mentionContentType = type({
  "files?": "unknown[]",
  text: "string",
  "thread_ts?": "string",
  ts: "string",
});

const editedMessageEventType = type({
  "edited?": "unknown",
  "subtype?": "string",
});

const directMessageIdentityType = type({
  "bot_id?": "string",
  channel: "string",
  channel_type: "'im'",
  "subtype?": "string",
  user: "string",
});

const directMessageContentType = type({
  "files?": "unknown[]",
  text: "string",
  "thread_ts?": "string",
  ts: "string",
});

const actionBodyMetadataType = type({
  "channel?": {
    id: "string",
  },
  "container?": {
    channel_id: "string",
    message_ts: "string",
    "thread_ts?": "string",
  },
  "enterprise?": type({
    id: "string",
  }).or("null"),
  "message?": {
    "thread_ts?": "string",
    ts: "string",
  },
  team: {
    id: "string",
  },
  user: {
    id: "string",
  },
});

const actionStringValueType = type({
  value: "string",
});

const approvalActionValueType = actionStringValueType.narrow((action) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(action.value),
);

const finalDetailsActionValueType = type("string.json.parse").to({
  threadId: "string",
  "usage?": {
    inputTokens: "number.integer >= 0",
    outputTokens: "number.integer >= 0",
    reasoningTokens: "number.integer >= 0",
  },
});

const newSessionActionValueType = type({
  value: "string",
}).narrow((action) => action.value === "new-session");

interface ActionBodyMetadata {
  channel: {
    id: string;
  };
  enterprise?: {
    id: string;
  } | null;
  message: {
    thread_ts?: string;
    ts: string;
  };
  team: {
    id: string;
  };
  user: {
    id: string;
  };
}

export function parseActionBody(body: unknown): ActionBodyMetadata | undefined {
  const parsed = tryParseArk(actionBodyMetadataType, body, "Slack action metadata");
  if (!parsed.ok) {
    return undefined;
  }

  const channelId = parsed.value.channel?.id ?? parsed.value.container?.channel_id;
  const messageTs = parsed.value.message?.ts ?? parsed.value.container?.message_ts;
  const threadTs = parsed.value.message?.thread_ts ?? parsed.value.container?.thread_ts;
  if (channelId === undefined || messageTs === undefined) {
    return undefined;
  }

  return {
    channel: { id: channelId },
    message: {
      ts: messageTs,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    },
    team: parsed.value.team,
    user: parsed.value.user,
    ...(parsed.value.enterprise === undefined ? {} : { enterprise: parsed.value.enterprise }),
  };
}

function parseApprovalActionValue(action: unknown): string | undefined {
  const parsed = tryParseArk(approvalActionValueType, action, "Slack approval action value");
  return parsed.ok ? parsed.value.value : undefined;
}

function parseFinalDetailsActionValue(
  action: unknown,
): typeof finalDetailsActionValueType.infer | undefined {
  const actionValue = tryParseArk(actionStringValueType, action, "Slack details action value");
  if (!actionValue.ok) {
    return undefined;
  }
  const details = tryParseArk(
    finalDetailsActionValueType,
    actionValue.value.value,
    "Slack details payload",
  );
  return details.ok ? details.value : undefined;
}

function parseEventMetadata(body: unknown):
  | {
      enterprise_id?: string;
      event_id: string;
      team_id: string;
    }
  | undefined {
  const parsed = tryParseArk(eventBodyMetadataType, body, "Slack event metadata");
  if (!parsed.ok) {
    return undefined;
  }
  return {
    event_id: parsed.value.event_id,
    team_id: parsed.value.team_id,
    ...(parsed.value.enterprise_id === undefined
      ? {}
      : { enterprise_id: parsed.value.enterprise_id }),
  };
}

function parseMentionIdentity(event: unknown):
  | {
      channel: string;
      user: string;
    }
  | undefined {
  const parsed = tryParseArk(mentionIdentityType, event, "Slack mention identity");
  return parsed.ok ? parsed.value : undefined;
}

function parseMentionContent(event: unknown):
  | {
      files?: unknown[];
      text: string;
      thread_ts?: string;
      ts: string;
    }
  | undefined {
  const parsed = tryParseArk(mentionContentType, event, "Slack mention content");
  if (!parsed.ok) {
    return undefined;
  }
  return {
    text: parsed.value.text,
    ts: parsed.value.ts,
    ...(parsed.value.thread_ts === undefined ? {} : { thread_ts: parsed.value.thread_ts }),
    ...(parsed.value.files === undefined ? {} : { files: parsed.value.files }),
  };
}

export function isEditedMessageEvent(event: unknown): boolean {
  const parsed = tryParseArk(editedMessageEventType, event, "Slack edited-message event");
  return (
    parsed.ok && (parsed.value.edited !== undefined || parsed.value.subtype === "message_changed")
  );
}

function parseDirectMessageIdentity(
  event: unknown,
): typeof directMessageIdentityType.infer | undefined {
  const parsed = tryParseArk(directMessageIdentityType, event, "Slack direct-message identity");
  return parsed.ok ? parsed.value : undefined;
}

function parseDirectMessageContent(
  event: unknown,
): typeof directMessageContentType.infer | undefined {
  const parsed = tryParseArk(directMessageContentType, event, "Slack direct-message content");
  return parsed.ok ? parsed.value : undefined;
}

function authorizationPolicy(config: BridgeConfig) {
  return {
    allowedChannelIds: config.allowedChannelIds,
    allowedTeamId: config.allowedTeamId,
    allowedUserId: config.allowedUserId,
    ...(config.allowedEnterpriseId === undefined
      ? {}
      : { allowedEnterpriseId: config.allowedEnterpriseId }),
  };
}

function identityFromActionBody(body: ActionBodyMetadata): SlackIdentity {
  return {
    channelId: body.channel.id,
    teamId: body.team.id,
    userId: body.user.id,
    ...(body.enterprise === null || body.enterprise === undefined
      ? {}
      : { enterpriseId: body.enterprise.id }),
  };
}

async function rejectUnauthorized(client: WebClient, identity: SlackIdentity): Promise<void> {
  try {
    await client.chat.postEphemeral({
      channel: identity.channelId,
      text: "This bot is private and isn’t available to this account.",
      user: identity.userId,
    });
  } catch {
    // A deliberately silent fallback prevents authorization failures from leaking details.
  }
}

async function setMessageStatusSafely(
  logger: Logger,
  responder: SlackResponder,
  reference: SlackMessageReference,
  status: SlackMessageStatus,
  eventId: string,
  previousStatus?: SlackMessageStatus,
): Promise<void> {
  try {
    await responder.setMessageStatus(reference, status, previousStatus);
  } catch (error) {
    logger.warn(
      {
        error,
        eventId,
        messageTs: reference.messageTs,
        status,
      },
      "Unable to update Slack message reaction",
    );
  }
}

async function threadContextForMessage(input: {
  allowedChannelIds: ReadonlySet<string>;
  channelId: string;
  client: WebClient;
  eventId: string;
  logger: Logger;
  messageTs: string;
  threadTs?: string;
}): Promise<string | undefined> {
  if (input.threadTs === undefined) {
    return undefined;
  }
  try {
    return await loadSlackThreadContext({
      allowedChannelIds: input.allowedChannelIds,
      channelId: input.channelId,
      currentMessageTs: input.messageTs,
      fetchReplies: async (request) => input.client.conversations.replies(request),
      onForwardedThreadError: (reference, forwardedThreadError) => {
        input.logger.warn(
          {
            channelId: input.channelId,
            error: forwardedThreadError,
            eventId: input.eventId,
            forwardedChannelId: reference.channelId,
            forwardedThreadTs: reference.threadTs,
          },
          "Unable to load forwarded Slack thread context",
        );
      },
      threadTs: input.threadTs,
    });
  } catch (error) {
    input.logger.warn(
      {
        channelId: input.channelId,
        error,
        eventId: input.eventId,
        threadTs: input.threadTs,
      },
      "Unable to load Slack thread context",
    );
    return undefined;
  }
}

function observeAuthorizedReceipt(
  dependencies: SlackAppDependencies,
  receipt: AuthorizedSlackReceipt,
): void {
  const failed = () => {
    try {
      dependencies.logger.warn("Authorized Slack receipt health observation failed");
    } catch {}
  };
  try {
    void Promise.resolve(dependencies.onAuthorizedReceipt?.(receipt)).catch(failed);
  } catch {
    failed();
  }
}

export function createSlackApp(config: BridgeConfig, dependencies: SlackAppDependencies): App {
  const redactText = (text: string): string =>
    redactSensitiveText(text, [config.botToken, config.appToken]);
  const sdkLogger: SlackSdkLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {
      try {
        dependencies.logger.warn("Slack SDK request warning");
      } catch {}
    },
    error: () => {
      try {
        dependencies.logger.warn("Slack SDK transport error");
      } catch {}
    },
    setLevel: () => {},
    setName: () => {},
    getLevel: () => LogLevel.ERROR,
  };
  let controlSignal = AbortSignal.abort();
  const socketReceiver = new SocketModeReceiver({
    appToken: config.appToken,
    autoReconnectEnabled: false,
    logger: sdkLogger,
    logLevel: LogLevel.ERROR,
    installerOptions: {
      clientOptions: {
        timeout: 5_000,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        fetch: slackRequestFetch({
          signal: () => controlSignal,
          timeoutMs: 5_000,
          ...(dependencies.slackFetch === undefined ? {} : { fetch: dependencies.slackFetch }),
        }),
      },
    },
  });
  const connection = new SlackConnectionLifecycle({
    transport: {
      connect: (signal) => {
        controlSignal = signal;
        return socketReceiver.start();
      },
      disconnect: () => socketReceiver.client.disconnect(),
      subscribe: (event, listener) => {
        socketReceiver.client.on(event, listener);
        return () => {
          socketReceiver.client.removeListener(event, listener);
        };
      },
    },
    ...(dependencies.onConnectionState === undefined
      ? {}
      : { onChanged: dependencies.onConnectionState }),
  });
  const receiver: Receiver = {
    init: (app) => socketReceiver.init(app),
    start: () => connection.start(),
    stop: () => connection.stop(),
  };
  const app = new App({
    receiver,
    deferInitialization: true,
    logger: sdkLogger,
    logLevel: LogLevel.ERROR,
    clientOptions: {
      timeout: 15_000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      fetch: slackRequestFetch({
        signal: () => connection.signal,
        timeoutMs: 15_000,
        ...(dependencies.slackFetch === undefined ? {} : { fetch: dependencies.slackFetch }),
      }),
    },
    token: config.botToken,
  });
  const policy = authorizationPolicy(config);

  app.event("app_mention", async ({ body, client, event }) => {
    const bodyMetadata = parseEventMetadata(body);
    if (isEditedMessageEvent(event)) {
      dependencies.logger.debug(
        bodyMetadata === undefined ? {} : { eventId: bodyMetadata.event_id },
        "Ignored edited Slack app mention",
      );
      return;
    }
    const eventIdentity = parseMentionIdentity(event);
    if (bodyMetadata === undefined || eventIdentity === undefined) {
      dependencies.logger.warn("Rejected malformed Slack app_mention metadata");
      return;
    }

    const identity: SlackIdentity = {
      channelId: eventIdentity.channel,
      teamId: bodyMetadata.team_id,
      userId: eventIdentity.user,
      ...(bodyMetadata.enterprise_id === undefined
        ? {}
        : { enterpriseId: bodyMetadata.enterprise_id }),
    };
    const authorization = authorizeSlackIdentity(identity, policy);
    if (!authorization.authorized) {
      dependencies.logger.warn(
        {
          channelId: identity.channelId,
          reason: authorization.reason,
          teamId: identity.teamId,
          userId: identity.userId,
        },
        "Rejected unauthorized Slack mention",
      );
      await rejectUnauthorized(client, identity);
      return;
    }

    const processedAt = new Date().toISOString();
    if (!dependencies.store.claimEvent(bodyMetadata.event_id, processedAt)) {
      dependencies.logger.debug(
        { eventId: bodyMetadata.event_id },
        "Ignored duplicate Slack event",
      );
      return;
    }

    const content = parseMentionContent(event);
    if (content === undefined) {
      dependencies.logger.warn("Rejected malformed Slack app_mention content");
      return;
    }
    if (!dependencies.store.claimMessage(identity.channelId, content.ts, processedAt)) {
      dependencies.logger.debug(
        { channelId: identity.channelId, eventId: bodyMetadata.event_id, messageTs: content.ts },
        "Ignored previously processed Slack message",
      );
      return;
    }

    observeAuthorizedReceipt(dependencies, {
      eventId: bodyMetadata.event_id,
      receivedAt: processedAt,
    });
    const responder = new WebApiSlackResponder(client, config.maxSlackResponseChars, redactText);
    const messageReference = {
      channelId: identity.channelId,
      messageTs: content.ts,
    };
    await setMessageStatusSafely(
      dependencies.logger,
      responder,
      messageReference,
      "acknowledged",
      bodyMetadata.event_id,
    );
    let downloaded: Awaited<ReturnType<typeof downloadSlackImages>> | undefined;
    try {
      const images = parseSlackImages(content.files ?? []);
      downloaded = await downloadSlackImages(images, config.botToken);
      const requestText = removeBotMention(content.text);
      const slackContext = await threadContextForMessage({
        allowedChannelIds: config.allowedChannelIds,
        channelId: identity.channelId,
        client,
        eventId: bodyMetadata.event_id,
        logger: dependencies.logger,
        messageTs: content.ts,
        ...(content.thread_ts === undefined ? {} : { threadTs: content.thread_ts }),
      });
      await dependencies.service.handleMention({
        command: (dependencies.parseCommand ?? parseMention)(
          requestText.length === 0 && images.length > 0
            ? "Please analyze the attached image(s)."
            : requestText,
        ),
        eventId: bodyMetadata.event_id,
        identity,
        responder,
        slackMessageTs: content.ts,
        slackThreadTs: content.thread_ts ?? content.ts,
        ...(downloaded.paths.length === 0 ? {} : { imagePaths: downloaded.paths }),
        ...(slackContext === undefined ? {} : { slackContext }),
      });
    } catch (error) {
      try {
        await responder.postError(
          {
            channelId: identity.channelId,
            threadTs: content.thread_ts ?? content.ts,
          },
          error instanceof Error ? error.message : "Unable to process Slack images.",
        );
      } finally {
        await setMessageStatusSafely(
          dependencies.logger,
          responder,
          messageReference,
          "failed",
          bodyMetadata.event_id,
          "acknowledged",
        );
      }
    } finally {
      await downloaded?.cleanup();
    }
  });

  app.event("message", async ({ body, client, context, event }) => {
    const bodyMetadata = parseEventMetadata(body);
    const messageIdentity = parseDirectMessageIdentity(event);
    if (
      bodyMetadata === undefined ||
      messageIdentity === undefined ||
      messageIdentity.bot_id !== undefined ||
      messageIdentity.subtype !== undefined
    ) {
      return;
    }
    const identity: SlackIdentity = {
      channelId: messageIdentity.channel,
      teamId: bodyMetadata.team_id,
      userId: messageIdentity.user,
      ...(bodyMetadata.enterprise_id === undefined
        ? {}
        : { enterpriseId: bodyMetadata.enterprise_id }),
    };
    const authorization = authorizeSlackIdentity(identity, policy, { directMessage: true });
    if (!authorization.authorized) {
      dependencies.logger.warn(
        {
          reason: authorization.reason,
          teamId: identity.teamId,
          userId: identity.userId,
        },
        "Rejected unauthorized Slack direct message",
      );
      await rejectUnauthorized(client, identity);
      return;
    }
    const message = parseDirectMessageContent(event);
    if (message === undefined) {
      dependencies.logger.warn("Rejected malformed authorized Slack direct message");
      return;
    }
    const processedAt = new Date().toISOString();
    if (!dependencies.store.claimEvent(bodyMetadata.event_id, processedAt)) {
      return;
    }
    if (!dependencies.store.claimMessage(identity.channelId, message.ts, processedAt)) {
      dependencies.logger.debug(
        { channelId: identity.channelId, eventId: bodyMetadata.event_id, messageTs: message.ts },
        "Ignored previously processed Slack message",
      );
      return;
    }

    observeAuthorizedReceipt(dependencies, {
      eventId: bodyMetadata.event_id,
      receivedAt: processedAt,
    });
    const responder = new WebApiSlackResponder(client, config.maxSlackResponseChars, redactText);
    const messageReference = {
      channelId: identity.channelId,
      messageTs: message.ts,
    };
    await setMessageStatusSafely(
      dependencies.logger,
      responder,
      messageReference,
      "acknowledged",
      bodyMetadata.event_id,
    );
    let downloaded: Awaited<ReturnType<typeof downloadSlackImages>> | undefined;
    try {
      const images = parseSlackImages(message.files ?? []);
      downloaded = await downloadSlackImages(images, config.botToken);
      const addressedText = removeAddressedBotMention(message.text, context.botUserId);
      const requestText =
        addressedText.trim().length === 0 && images.length > 0
          ? "Please analyze the attached image(s)."
          : addressedText;
      const slackContext = await threadContextForMessage({
        allowedChannelIds: config.allowedChannelIds,
        channelId: identity.channelId,
        client,
        eventId: bodyMetadata.event_id,
        logger: dependencies.logger,
        messageTs: message.ts,
        ...(message.thread_ts === undefined ? {} : { threadTs: message.thread_ts }),
      });
      await dependencies.service.handleMention({
        command: (dependencies.parseCommand ?? parseMention)(requestText),
        directMessage: true,
        eventId: bodyMetadata.event_id,
        identity,
        responder,
        slackMessageTs: message.ts,
        slackThreadTs: message.thread_ts ?? message.ts,
        ...(downloaded.paths.length === 0 ? {} : { imagePaths: downloaded.paths }),
        ...(slackContext === undefined ? {} : { slackContext }),
      });
    } catch (error) {
      try {
        await responder.postError(
          {
            channelId: identity.channelId,
            threadTs: message.thread_ts ?? message.ts,
          },
          error instanceof Error ? error.message : "Unable to process Slack images.",
        );
      } finally {
        await setMessageStatusSafely(
          dependencies.logger,
          responder,
          messageReference,
          "failed",
          bodyMetadata.event_id,
          "acknowledged",
        );
      }
    } finally {
      await downloaded?.cleanup();
    }
  });

  const registerApprovalAction = (
    actionId: "bridge_approve_once" | "bridge_deny",
    approved: boolean,
  ): void => {
    app.action(actionId, async ({ ack, action, body, client }) => {
      await ack();

      const bodyMetadata = parseActionBody(body);
      if (bodyMetadata === undefined) {
        dependencies.logger.warn("Rejected malformed Slack approval metadata");
        return;
      }

      const identity = identityFromActionBody(bodyMetadata);
      const authorization = authorizeSlackIdentity(identity, policy, {
        directMessage: identity.channelId.startsWith("D"),
      });
      if (!authorization.authorized) {
        dependencies.logger.warn(
          {
            channelId: identity.channelId,
            reason: authorization.reason,
            teamId: identity.teamId,
            userId: identity.userId,
          },
          "Rejected unauthorized Slack approval",
        );
        await rejectUnauthorized(client, identity);
        return;
      }

      const actionValue = parseApprovalActionValue(action);
      if (actionValue === undefined) {
        dependencies.logger.warn("Rejected malformed Slack approval value");
        return;
      }

      const responder = new WebApiSlackResponder(client, config.maxSlackResponseChars, redactText);
      await dependencies.service.handleApproval({
        approvalId: actionValue,
        approved,
        identity,
        replyContext: {
          channelId: identity.channelId,
          threadTs: bodyMetadata.message.thread_ts ?? bodyMetadata.message.ts,
        },
        responder,
      });
    });
  };

  registerApprovalAction("bridge_approve_once", true);
  registerApprovalAction("bridge_deny", false);

  app.action("bridge_open_dashboard", async ({ ack }) => {
    await ack();
  });

  app.action("bridge_stop_run", async ({ ack, action, body, client }) => {
    await ack();

    const bodyMetadata = parseActionBody(body);
    const actionValue = tryParseArk(actionStringValueType, action, "Slack stop-run action value");
    if (bodyMetadata === undefined || !actionValue.ok) {
      dependencies.logger.warn("Rejected malformed Slack stop-run action");
      return;
    }

    const identity = identityFromActionBody(bodyMetadata);
    const directMessage = identity.channelId.startsWith("D");
    const authorization = authorizeSlackIdentity(identity, policy, { directMessage });
    if (!authorization.authorized) {
      await rejectUnauthorized(client, identity);
      return;
    }

    const run = dependencies.store.findTrackedRun(actionValue.value.value);
    const threadTs = bodyMetadata.message.thread_ts ?? bodyMetadata.message.ts;
    if (
      run === undefined ||
      run.channelId !== identity.channelId ||
      (!directMessage && run.slackThreadTs !== threadTs)
    ) {
      dependencies.logger.warn("Rejected stale or mismatched Slack stop-run action");
      return;
    }

    await dependencies.service.handleStopRun({
      directMessage,
      eventId: run.eventId,
      identity,
      replyContext: {
        channelId: identity.channelId,
        threadTs,
      },
      responder: new WebApiSlackResponder(client, config.maxSlackResponseChars, redactText),
    });
  });

  app.action("bridge_show_details", async ({ ack, action, body, client }) => {
    await ack();

    const bodyMetadata = parseActionBody(body);
    const details = parseFinalDetailsActionValue(action);
    if (bodyMetadata === undefined || details === undefined) {
      dependencies.logger.warn("Rejected malformed Slack details action");
      return;
    }

    const identity = identityFromActionBody(bodyMetadata);
    const authorization = authorizeSlackIdentity(identity, policy, {
      directMessage: identity.channelId.startsWith("D"),
    });
    if (!authorization.authorized) {
      await rejectUnauthorized(client, identity);
      return;
    }

    const lines = [`Codex thread: \`${details.threadId}\``];
    if (details.usage !== undefined) {
      lines.push(
        `Usage: ${details.usage.inputTokens.toLocaleString()} input · ${details.usage.outputTokens.toLocaleString()} output · ${details.usage.reasoningTokens.toLocaleString()} reasoning tokens`,
      );
    }
    await client.chat.postEphemeral({
      channel: identity.channelId,
      text: lines.join("\n"),
      thread_ts: bodyMetadata.message.thread_ts ?? bodyMetadata.message.ts,
      user: identity.userId,
    });
  });

  app.action("bridge_new_session", async ({ ack, action, body, client }) => {
    await ack();

    const bodyMetadata = parseActionBody(body);
    const actionValue = tryParseArk(
      newSessionActionValueType,
      action,
      "Slack new-session action value",
    );
    if (bodyMetadata === undefined || !actionValue.ok) {
      dependencies.logger.warn("Rejected malformed Slack new-session action");
      return;
    }

    const identity = identityFromActionBody(bodyMetadata);
    const directMessage = identity.channelId.startsWith("D");
    const authorization = authorizeSlackIdentity(identity, policy, { directMessage });
    if (!authorization.authorized) {
      await rejectUnauthorized(client, identity);
      return;
    }

    const replyContext = {
      channelId: identity.channelId,
      threadTs: bodyMetadata.message.thread_ts ?? bodyMetadata.message.ts,
    };
    await dependencies.service.handleNewSession({
      directMessage,
      identity,
      replyContext,
      responder: new WebApiSlackResponder(client, config.maxSlackResponseChars, redactText),
    });
  });

  return app;
}
