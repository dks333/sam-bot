import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type } from "arktype";

import { parseArk } from "../validation/parse.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const slackFileType = type({
  id: "string",
  mimetype: "'image/png' | 'image/jpeg' | 'image/webp'",
  name: "string",
  size: "0 <= number.integer <= 10485760",
  url_private_download: "string.url",
}).narrow((file) => file.url_private_download.startsWith("https://"));

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

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "slack-codex-images-"));
  await chmod(temporaryDirectory, 0o700);
  const imagePaths: string[] = [];
  const cleanup = async (): Promise<void> => {
    await rm(temporaryDirectory, { force: true, recursive: true });
  };

  try {
    for (const [index, file] of files.entries()) {
      const response = await fetcher(file.url_private_download, {
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Slack image download failed with HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > MAX_IMAGE_BYTES) {
        throw new Error(`${file.name} is larger than 10 MiB.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`${file.name} is larger than 10 MiB.`);
      }
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
