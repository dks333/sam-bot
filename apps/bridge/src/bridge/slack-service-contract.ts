import type { SlackIdentity } from "../slack/authorize.js";
import type { MentionCommand } from "../slack/mentions.js";
import type { SlackReplyContext, SlackResponder } from "../slack/responder.js";

export interface HandleMentionInput {
  command: MentionCommand;
  directMessage?: boolean;
  eventId: string;
  imagePaths?: string[];
  identity: SlackIdentity;
  responder: SlackResponder;
  slackContext?: string;
  slackMessageTs: string;
  slackThreadTs: string;
}

export interface HandleApprovalInput {
  approvalId: string;
  approved: boolean;
  identity: SlackIdentity;
  replyContext: SlackReplyContext;
  responder: SlackResponder;
}

export interface HandleConversationActionInput {
  directMessage?: boolean;
  eventId?: string;
  identity: SlackIdentity;
  replyContext: SlackReplyContext;
  responder: SlackResponder;
}

export interface SlackService {
  handleMention(input: HandleMentionInput): Promise<void>;
  handleApproval(input: HandleApprovalInput): Promise<void>;
  handleStopRun(input: HandleConversationActionInput): Promise<void>;
  handleNewSession(input: HandleConversationActionInput): Promise<void>;
}
