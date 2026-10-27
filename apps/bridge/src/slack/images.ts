import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type } from "arktype";

import { parseArk } from "../validation/parse.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const imageDownloadTimeoutMs = 15_000;
const maximumRedirects = 3;

function trustedSlackFileUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "files.slack.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

const slackFileType = type({
  id: "string",
  mimetype: "'image/png' | 'image/jpeg' | 'image/webp'",
  name: "string",
  size: "0 <= number.integer <= 10485760",
  "is_external?": "boolean",
  "mode?": "string",
  "filetype?": "string",
  url_private_download: "string.url",
}).narrow(
  (file) =>
    file.is_external !== true &&
    file.mode !== "external" &&
    file.filetype !== "remote" &&
    trustedSlackFileUrl(file.url_private_download),
);

export type SlackImageFile = typeof slackFileType.infer;

export interface DownloadedImages {
  cleanup(): Promise<void>;
  paths: string[];
}

export interface ImageFetcher {
  (url: string, init: RequestInit): Promise<Response>;
}

export function parseSlackImages(files: unknown[]): SlackImageFile[] {
  if (files.length > MAX_IMAGES) {
    throw new Error(`Attach at most ${MAX_IMAGES} images per request.`);
  }
  return files.map((file, index) => parseArk(slackFileType, file, `Slack image ${index + 1}`));
}

function extensionForMime(mimetype: SlackImageFile["mimetype"]): string {
  if (mimetype === "image/png") {
    return ".png";
  }
  if (mimetype === "image/jpeg") {
    return ".jpg";
  }
  return ".webp";
}

function hasValidMagic(bytes: Uint8Array, mimetype: SlackImageFile["mimetype"]): boolean {
  if (mimetype === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte);
  }
  if (mimetype === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

async function beforeAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function imageResponse(
  file: SlackImageFile,
  botToken: string,
  fetcher: ImageFetcher,
  signal: AbortSignal,
): Promise<Response> {
  let url = file.url_private_download;
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    if (!trustedSlackFileUrl(url)) throw new Error("Only Slack-hosted images can be downloaded.");
    const pending = fetcher(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      redirect: "manual",
      signal,
    });
    void pending.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await beforeAbort(pending, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (location === null || redirect === maximumRedirects)
        throw new Error("Slack image download exceeded its redirect limit.");
      const target = new URL(location, url).href;
      if (!trustedSlackFileUrl(target))
        throw new Error("Slack image download redirected outside its trusted file host.");
      url = target;
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`Slack image download failed with HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error("Slack image download exceeded its redirect limit.");
}

async function imageBytes(
  response: Response,
  file: SlackImageFile,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_IMAGE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`${file.name} is larger than 10 MiB.`);
  }
  if (response.body === null) throw new Error("Slack returned an empty image response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await beforeAbort(reader.read(), signal);
      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 10 MiB.`);
      chunks.push(next.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function downloadSlackImages(
  files: SlackImageFile[],
  botToken: string,
  fetcher: ImageFetcher = async (url, init) => fetch(url, init),
): Promise<DownloadedImages> {
  if (files.length === 0) {
    return {
      cleanup: async () => undefined,
      paths: [],
    };
  }
  const checkedFiles = parseSlackImages(files);

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "slack-codex-images-"));
  await chmod(temporaryDirectory, 0o700);
  const imagePaths: string[] = [];
  const cleanup = async (): Promise<void> => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  };

  try {
    for (const [index, file] of checkedFiles.entries()) {
      const signal = AbortSignal.timeout(imageDownloadTimeoutMs);
      const response = await imageResponse(file, botToken, fetcher, signal);
      const bytes = await imageBytes(response, file, signal);
      if (!hasValidMagic(bytes, file.mimetype)) {
        throw new Error(`${file.name} does not match its declared image format.`);
      }
      const imagePath = path.join(
        temporaryDirectory,
        `image-${index + 1}${extensionForMime(file.mimetype)}`,
      );
      const handle = await open(imagePath, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      imagePaths.push(imagePath);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    cleanup,
    paths: imagePaths,
  };
}
