import { isSlackChannelAllowed } from "./channel-policy.js";

export interface AuthorizationPolicy {
  allowedChannelIds: ReadonlySet<string>;
  allowedEnterpriseId?: string;
  allowedTeamId: string;
  allowedUserId: string;
}

export interface SlackIdentity {
  channelId: string;
  enterpriseId?: string;
  teamId: string;
  userId: string;
}

export type AuthorizationResult =
  | { authorized: true }
  | {
      authorized: false;
      reason: "channel" | "enterprise" | "team" | "user";
    };

export function authorizeSlackIdentity(
  identity: SlackIdentity,
  policy: AuthorizationPolicy,
  options: {
    directMessage?: boolean;
  } = {},
): AuthorizationResult {
  if (identity.teamId !== policy.allowedTeamId) {
    return { authorized: false, reason: "team" };
  }

  if (identity.userId !== policy.allowedUserId) {
    return { authorized: false, reason: "user" };
  }

  if (
    options.directMessage !== true &&
    !isSlackChannelAllowed(policy.allowedChannelIds, identity.channelId)
  ) {
    return { authorized: false, reason: "channel" };
  }

  if (
    policy.allowedEnterpriseId !== undefined &&
    identity.enterpriseId !== policy.allowedEnterpriseId
  ) {
    return { authorized: false, reason: "enterprise" };
  }

  return { authorized: true };
}
