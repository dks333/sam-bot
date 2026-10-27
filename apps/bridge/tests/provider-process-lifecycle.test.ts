import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProcessAppServerConnection } from "../src/codex/app-server-client.js";

const directories: string[] = [];
const connections: ProcessAppServerConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("provider process lifecycle", () => {
  it("rejects a broken Codex pipe and terminates the failed child", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "provider-process-"));
    directories.push(directory);
    const executablePath = path.join(directory, "fake-codex.cjs");
    const readyPath = path.join(directory, "ready");
    const pidPath = path.join(directory, "pid");
    await writeFile(
      executablePath,
      `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
readline.createInterface({input:process.stdin}).on("line", line => {
 const message = JSON.parse(line);
 if(message.method === "initialize") process.stdout.write(JSON.stringify({id:message.id,result:{userAgent:"synthetic"}}) + "\\n");
 if(message.method === "initialized") {
  fs.closeSync(0);
  fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
  setInterval(() => {}, 1000);
 }
});
`,
    );
    await chmod(executablePath, 0o700);
    const connection = await ProcessAppServerConnection.create({ executablePath });
    connections.push(connection);
    const events: unknown[] = [];
    connection.subscribe((event) => events.push(event));
    await vi.waitFor(async () => expect(await readFile(readyPath, "utf8")).toBe("ready"));
    const request = connection.request("thread/start", { cwd: directory });
    await expect(request).rejects.toThrow("EPIPE");
    await Promise.all([connection.close(), connection.close()]);
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(events).toContainEqual(expect.objectContaining({ method: "transport/closed" }));
  });
});
