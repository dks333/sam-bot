import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { productPaths } from "../src/config/paths.js";
import { defaultProductConfig, loadProduct } from "../src/config/product.js";
import { startNativeSlack } from "../src/native-main.js";
import {
  NativeConversationStore,
  readNativeConversationSchemaVersion,
} from "../src/persistence/native-conversation-store.js";
import { SqliteStore } from "../src/persistence/sqlite.js";
import { acquireRuntimeOwner } from "../src/runtime/runtime-owner.js";

vi.mock("pino", () => ({
  default: Object.assign(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), {
    destination: vi.fn(),
  }),
}));

vi.mock("../src/runtime/runtime-owner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/runtime/runtime-owner.js")>();
  return { ...original, acquireRuntimeOwner: vi.fn(original.acquireRuntimeOwner) };
});

vi.mock("../src/slack/app.js", () => ({
  createSlackApp: () => {
    throw new Error("Unexpected synthetic Slack initialization");
  },
}));

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.clearAllMocks();
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-startup-ownership-"));
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }));
  const paths = productPaths(directory);
  const config = defaultProductConfig(directory);
  config.codex.home = path.join(directory, "synthetic-codex");
  config.runtime.logLevel = "silent";
  writeFileSync(paths.configFile, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(
    paths.secretsFile,
    "SLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\n",
    { mode: 0o600 },
  );
  return {
    product: loadProduct(paths),
    nativeFile: path.join(directory, "native-conversations.sqlite"),
  };
}

describe("native startup ownership", () => {
  it("rejects an unsupported Node version before opening runtime storage", async () => {
    const { product } = fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
    if (descriptor === undefined) throw new Error("Expected the runtime Node version");
    const open = vi.spyOn(SqliteStore, "open");
    Object.defineProperty(process.versions, "node", { value: "22.13.0" });
    try {
      await expect(startNativeSlack(product)).rejects.toThrow("SQLite requires Node-API 10");
      expect(open).not.toHaveBeenCalled();
      expect(acquireRuntimeOwner).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.versions, "node", descriptor);
      open.mockRestore();
    }
  });

  it("refuses a second runtime before migrating the live owner's version-one ledger", async () => {
    const { product, nativeFile } = fixture();
    const native = new NativeConversationStore(nativeFile);
    native.close();
    const raw = new Database(nativeFile);
    raw.exec(
      "ALTER TABLE native_deliveries DROP COLUMN enterprise_id; ALTER TABLE native_deliveries DROP COLUMN direct_message; ALTER TABLE native_deliveries DROP COLUMN revoked_at",
    );
    raw.pragma("user_version = 1");
    raw.close();
    const store = SqliteStore.open(product.paths.databaseFile);
    cleanups.push(() => store.close());
    const owner = acquireRuntimeOwner({ store, onOwnershipLost: () => {} });
    cleanups.push(() => owner.release());
    vi.mocked(acquireRuntimeOwner).mockClear();

    await expect(startNativeSlack(product)).rejects.toThrow("Another runtime owns");

    expect(acquireRuntimeOwner).toHaveBeenCalledOnce();
    expect(readNativeConversationSchemaVersion(nativeFile)).toBe(1);
    owner.assertOwned();
    const inspected = new Database(nativeFile, { readonly: true });
    try {
      expect(
        inspected
          .prepare(
            "SELECT name FROM pragma_table_info('native_deliveries') WHERE name='revoked_at'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      inspected.close();
    }
  });

  it("releases its acquired owner when native ledger migration fails", async () => {
    const { product, nativeFile } = fixture();
    const raw = new Database(nativeFile);
    raw.pragma("user_version = 99");
    raw.close();

    await expect(startNativeSlack(product)).rejects.toThrow("newer than this release");

    expect(acquireRuntimeOwner).toHaveBeenCalledOnce();
    const store = SqliteStore.open(product.paths.databaseFile);
    cleanups.push(() => store.close());
    expect(store.getRuntimeOwner()).toBeUndefined();
    const successor = acquireRuntimeOwner({ store, onOwnershipLost: () => {} });
    cleanups.push(() => successor.release());
    successor.assertOwned();
  });
});
