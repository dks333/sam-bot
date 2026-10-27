import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function secretQuestion(
  prompt: string,
  fallback: string | undefined,
): Promise<string> {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  terminal.once("SIGINT", () => controller.abort());
  terminal.once("close", () => controller.abort());
  try {
    let suffix = "";
    if (fallback !== undefined && fallback.length > 0) {
      suffix = " [press Enter to keep saved value]";
    }
    process.stdout.write(`${prompt}${suffix}: `);
    const answer = (await terminal.question("", { signal: controller.signal })).trim();
    if (answer.length > 0) return answer;
    if (fallback !== undefined && fallback.length > 0) return fallback;
    throw new Error(`${prompt} is required.`);
  } finally {
    terminal.close();
    output.end();
    process.stdout.write("\n");
  }
}
