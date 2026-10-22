export interface MentionCommand {
  type: "prompt";
  prompt: string;
}

export function removeBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gu, "").trim();
}

export function removeAddressedBotMention(text: string, botUserId?: string): string {
  const mention = /^\s*<@([A-Z0-9]+)>\s*/u.exec(text);
  if (botUserId === undefined || mention === null || mention[1] !== botUserId) return text;
  return text.slice(mention[0].length);
}

export function parseMention(text: string): MentionCommand {
  return { type: "prompt", prompt: text };
}
