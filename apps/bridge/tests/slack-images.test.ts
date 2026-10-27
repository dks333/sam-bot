import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadSlackImages, parseSlackImages, type ImageFetcher } from "../src/slack/images.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function file(overrides: Record<string, unknown> = {}) {
  return {
    id: "F_SYNTHETIC",
    mimetype: "image/png",
    name: "synthetic.png",
    size: png.byteLength,
    url_private_download: "https://files.slack.com/files-pri/synthetic.png",
    ...overrides,
  };
}

function temporaryRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sam-image-test-"));
  directories.push(directory);
  vi.spyOn(os, "tmpdir").mockReturnValue(directory);
  return directory;
}

describe("Slack image downloads", () => {
  it.each([
    "https://files.slack.com.example.com/image.png",
    "https://sub.files.slack.com/image.png",
    "http://files.slack.com/image.png",
    "https://files.slack.com:444/image.png",
    "https://synthetic@files.slack.com/image.png",
    "https://example.com/image.png",
  ])("rejects an untrusted initial image URL %s", (url) => {
    expect(() => parseSlackImages([file({ url_private_download: url })])).toThrow();
  });

  it.each([{ is_external: true }, { mode: "external" }, { filetype: "remote" }])(
    "rejects external file metadata %j",
    (metadata) => {
      expect(() => parseSlackImages([file(metadata)])).toThrow();
    },
  );

  it("accepts an exact Slack file host with the default HTTPS port", () => {
    expect(
      parseSlackImages([file({ url_private_download: "https://files.slack.com:443/image.png" })]),
    ).toHaveLength(1);
  });

  it("follows a bounded same-host redirect without automatically forwarding credentials", async () => {
    temporaryRoot();
    const fetcher = vi.fn<ImageFetcher>(async () => new Response(png));
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "/files-pri/redirected.png" } }),
    );
    const downloaded = await downloadSlackImages(
      parseSlackImages([file()]),
      "synthetic-token",
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://files.slack.com/files-pri/redirected.png");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
      headers: { Authorization: "Bearer synthetic-token" },
    });
    const filename = downloaded.paths[0];
    if (filename === undefined) throw new Error("Expected a synthetic downloaded image");
    expect(readFileSync(filename)).toEqual(Buffer.from(png));
    await downloaded.cleanup();
  });

  it("never follows an external redirect and removes its temporary directory", async () => {
    const root = temporaryRoot();
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/image.png" } }),
    );
    await expect(
      downloadSlackImages(parseSlackImages([file()]), "synthetic-token", fetcher),
    ).rejects.toThrow("outside its trusted file host");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it("terminates a same-host redirect loop", async () => {
    const root = temporaryRoot();
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 307, headers: { location: "/files-pri/again.png" } }),
    );
    await expect(
      downloadSlackImages(parseSlackImages([file()]), "synthetic-token", fetcher),
    ).rejects.toThrow("redirect limit");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(readdirSync(root)).toEqual([]);
  });

  it("cancels an oversized chunked response before consuming the remaining body", async () => {
    const root = temporaryRoot();
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    await expect(
      downloadSlackImages(
        parseSlackImages([file()]),
        "synthetic-token",
        async () => new Response(body),
      ),
    ).rejects.toThrow("larger than 10 MiB");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunks).toBeLessThanOrEqual(12);
    expect(readdirSync(root)).toEqual([]);
  });

  it("cancels a declared oversized response without reading it", async () => {
    const root = temporaryRoot();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(
      downloadSlackImages(
        parseSlackImages([file()]),
        "synthetic-token",
        async () => new Response(body, { headers: { "content-length": String(11 * 1024 * 1024) } }),
      ),
    ).rejects.toThrow("larger than 10 MiB");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it("enforces the deadline while waiting for response headers", async () => {
    const root = temporaryRoot();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    const pending = downloadSlackImages(parseSlackImages([file()]), "synthetic-token", fetcher);
    const failed = expect(pending).rejects.toThrow("Synthetic download deadline");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Synthetic download deadline"));
    await failed;
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(readdirSync(root)).toEqual([]);
  });

  it("cancels a stalled body when its deadline expires", async () => {
    const root = temporaryRoot();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
    });
    const pending = downloadSlackImages(
      parseSlackImages([file()]),
      "synthetic-token",
      async () => new Response(body),
    );
    const failed = expect(pending).rejects.toThrow("Synthetic body deadline");
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new Error("Synthetic body deadline"));
    await failed;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(readdirSync(root)).toEqual([]);
  });
});
