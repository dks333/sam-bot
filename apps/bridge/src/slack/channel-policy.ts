export const allSlackChannels = "*";

export function isSlackChannelAllowed(
  allowedChannelIds: ReadonlySet<string>,
  channelId: string,
): boolean {
  return allowedChannelIds.has(allSlackChannels) || allowedChannelIds.has(channelId);
}
