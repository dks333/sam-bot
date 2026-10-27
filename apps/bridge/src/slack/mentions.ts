export interface MentionCommand {
  type: "prompt";
  prompt: string;
}

export function removeBotMention(text: string, botUserId?: string): string {
  if (botUserId === undefined) return text;
  return text
    .replace(/<@([A-Z0-9]+)>/gu, (mention: string, userId: string) => {
      if (userId === botUserId) return "";
      return mention;
    })
    .trim();
}

export function removeAddressedBotMention(text: string, botUserId?: string): string {
  const mention = /^\s*<@([A-Z0-9]+)>\s*/u.exec(text);
  if (botUserId === undefined || mention === null || mention[1] !== botUserId) return text;
  return text.slice(mention[0].length);
}

export function parseMention(text: string): MentionCommand {
  return { type: "prompt", prompt: text };
}
