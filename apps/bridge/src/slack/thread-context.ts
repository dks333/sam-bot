import { isSlackChannelAllowed } from "./channel-policy.js";

const maximumThreadMessages = 100;
const maximumThreadContextCharacters = 12_000;
const maximumTextFragments = 80;
const maximumNestedDepth = 8;
const maximumForwardedThreads = 4;

const contentKeys = new Set([
  "alt_text",
  "author_name",
  "author_subname",
  "fallback",
  "filename",
  "footer",
  "name",
  "pretext",
  "service_name",
  "text",
  "title",
  "value",
]);

const linkKeys = new Set([
  "author_link",
  "from_url",
  "original_url",
  "share_url",
  "title_link",
  "url",
]);

interface SlackRepliesInput {
  channel: string;
  limit: number;
  ts: string;
}

export interface SlackThreadReference {
  channelId: string;
  threadTs: string;
}

export interface SlackThreadContextInput {
  allowedChannelIds: ReadonlySet<string>;
  channelId: string;
  currentMessageTs: string;
  fetchReplies(input: SlackRepliesInput): Promise<unknown>;
  onForwardedThreadError?(reference: SlackThreadReference, error: unknown): void;
  threadTs: string;
}

interface FormattedThread {
  forwardedThreads: SlackThreadReference[];
  messages: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedFragment(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function addFragment(fragments: string[], value: string): void {
  if (fragments.length >= maximumTextFragments) {
    return;
  }
  const normalized = normalizedFragment(value);
  if (normalized !== undefined && !fragments.includes(normalized)) {
    fragments.push(normalized);
  }
}

function collectNestedContent(value: unknown, fragments: string[], depth: number): void {
  if (depth > maximumNestedDepth || fragments.length >= maximumTextFragments) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedContent(item, fragments, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      typeof nestedValue === "string" &&
      (contentKeys.has(key) || (linkKeys.has(key) && nestedValue.startsWith("https://")))
    ) {
      addFragment(fragments, nestedValue);
      continue;
    }
    if (Array.isArray(nestedValue) || isRecord(nestedValue)) {
      collectNestedContent(nestedValue, fragments, depth + 1);
    }
  }
}

function slackTimestampFromMessagePath(value: string): string | undefined {
  if (!/^\d+$/u.test(value) || value.length <= 6) {
    return undefined;
  }
  const decimalIndex = value.length - 6;
  return `${value.slice(0, decimalIndex)}.${value.slice(decimalIndex)}`;
}

function slackThreadReference(value: string): SlackThreadReference | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!url.hostname.endsWith(".slack.com") && !url.hostname.endsWith(".slack-gov.com")) {
    return undefined;
  }
  const pathMatch = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d+)$/u.exec(url.pathname);
  const channelId = pathMatch?.[1];
  const pathTimestamp = pathMatch?.[2];
  if (channelId === undefined || pathTimestamp === undefined) {
    return undefined;
  }
  const queryChannelId = url.searchParams.get("cid");
  if (queryChannelId !== null && queryChannelId !== channelId) {
    return undefined;
  }
  const threadTs =
    url.searchParams.get("thread_ts") ?? slackTimestampFromMessagePath(pathTimestamp);
  if (threadTs === undefined || !/^\d+\.\d+$/u.test(threadTs)) {
    return undefined;
  }
  return { channelId, threadTs };
}

function addForwardedThread(
  forwardedThreads: SlackThreadReference[],
  reference: SlackThreadReference,
): void {
  if (
    forwardedThreads.length >= maximumForwardedThreads ||
    forwardedThreads.some(
      (existing) =>
        existing.channelId === reference.channelId && existing.threadTs === reference.threadTs,
    )
  ) {
    return;
  }
  forwardedThreads.push(reference);
}

function collectForwardedThreads(
  value: unknown,
  forwardedThreads: SlackThreadReference[],
  depth: number,
): void {
  if (depth > maximumNestedDepth || forwardedThreads.length >= maximumForwardedThreads) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectForwardedThreads(item, forwardedThreads, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "from_url" && typeof nestedValue === "string") {
      const reference = slackThreadReference(nestedValue);
      if (reference !== undefined) {
        addForwardedThread(forwardedThreads, reference);
      }
      continue;
    }
    if (Array.isArray(nestedValue) || isRecord(nestedValue)) {
      collectForwardedThreads(nestedValue, forwardedThreads, depth + 1);
    }
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function messageAuthor(message: Record<string, unknown>): string {
  const user = stringField(message, "user");
  if (user !== undefined) {
    return user;
  }
  const botProfile = message.bot_profile;
  if (isRecord(botProfile)) {
    const botName = stringField(botProfile, "name");
    if (botName !== undefined) {
      return botName;
    }
  }
  return stringField(message, "bot_id") ?? "unknown author";
}

function messageContent(message: Record<string, unknown>): string | undefined {
  const fragments: string[] = [];
  const text = stringField(message, "text");
  if (text !== undefined) {
    addFragment(fragments, text);
  }
  collectNestedContent(message.blocks, fragments, 0);
  collectNestedContent(message.attachments, fragments, 0);
  collectNestedContent(message.files, fragments, 0);
  return fragments.length === 0 ? undefined : fragments.join("\n");
}

function messagesFromResponse(response: unknown): unknown[] {
  if (!isRecord(response) || !Array.isArray(response.messages)) {
    return [];
  }
  return response.messages;
}

function isAfterCurrentMessage(messageTs: string, currentMessageTs: string): boolean {
  const messageTime = Number(messageTs);
  const currentMessageTime = Number(currentMessageTs);
  return Number.isFinite(messageTime) && Number.isFinite(currentMessageTime)
    ? messageTime > currentMessageTime
    : false;
}

function formatThreadMessages(
  messages: unknown[],
  currentMessageTs: string,
  excludedMessageTs?: string,
): FormattedThread {
  const formatted: string[] = [];
  const forwardedThreads: SlackThreadReference[] = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const messageTs = stringField(message, "ts");
    if (
      messageTs === excludedMessageTs ||
      (messageTs !== undefined && isAfterCurrentMessage(messageTs, currentMessageTs))
    ) {
      continue;
    }
    collectForwardedThreads(message.attachments, forwardedThreads, 0);
    const content = messageContent(message);
    if (content === undefined) {
      continue;
    }
    const label = formatted.length === 0 ? "Parent" : "Reply";
    const timestamp = messageTs === undefined ? "unknown timestamp" : messageTs;
    formatted.push(`${label} from ${messageAuthor(message)} at ${timestamp}:\n${content}`);
  }
  return { forwardedThreads, messages: formatted };
}

function truncateContext(context: string): string {
  if (context.length <= maximumThreadContextCharacters) {
    return context;
  }
  const suffix = "\n[Slack thread context truncated]";
  return `${context.slice(0, maximumThreadContextCharacters - suffix.length).trimEnd()}${suffix}`;
}

export async function loadSlackThreadContext(
  input: SlackThreadContextInput,
): Promise<string | undefined> {
  if (input.threadTs === input.currentMessageTs) {
    return undefined;
  }
  const response = await input.fetchReplies({
    channel: input.channelId,
    limit: maximumThreadMessages,
    ts: input.threadTs,
  });
  const outerThread = formatThreadMessages(
    messagesFromResponse(response),
    input.currentMessageTs,
    input.currentMessageTs,
  );
  const formatted = [...outerThread.messages];
  for (const reference of outerThread.forwardedThreads) {
    // A forwarded link can point at replies hidden from the destination channel, so cross-channel
    // hydration must stay inside the same channel policy as normal bot requests.
    if (
      reference.channelId !== input.channelId &&
      !isSlackChannelAllowed(input.allowedChannelIds, reference.channelId)
    ) {
      formatted.push(
        `[Forwarded Slack thread ${reference.channelId} at ${reference.threadTs} was not loaded because its source channel is not allowlisted]`,
      );
      continue;
    }
    try {
      const forwardedResponse = await input.fetchReplies({
        channel: reference.channelId,
        limit: maximumThreadMessages,
        ts: reference.threadTs,
      });
      const forwardedThread = formatThreadMessages(
        messagesFromResponse(forwardedResponse),
        input.currentMessageTs,
      );
      if (forwardedThread.messages.length > 0) {
        formatted.push(
          `Forwarded Slack thread ${reference.channelId} at ${reference.threadTs}:\n${forwardedThread.messages.join("\n\n")}`,
        );
      }
    } catch (error) {
      input.onForwardedThreadError?.(reference, error);
      formatted.push(
        `[Forwarded Slack thread ${reference.channelId} at ${reference.threadTs} could not be read by the Slack bot]`,
      );
    }
  }
  return formatted.length === 0 ? undefined : truncateContext(formatted.join("\n\n"));
}
