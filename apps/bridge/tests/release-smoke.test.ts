import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { verifyStagedRuntime } from "../src/cli/release-smoke.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "synthetic-release-smoke-"));
  directories.push(root);
  const write = (name: string, value: string): void => {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, value);
  };
  write("package.json", JSON.stringify({ name: "synthetic-runtime", type: "module" }));
  write(
    "dist/index.js",
    'throw new Error("The runtime service must never start during dependency verification");\n',
  );
  write(
    "dist/persistence/sqlite.js",
    'export class SqliteStore { static open(filename) { if (!filename.endsWith("legacy-schema.sqlite")) throw new Error("The schema probe must use an isolated file"); return new SqliteStore(); } close() {} }\n',
  );
  write("dist/persistence/legacy-schema.js", "export const legacyMigrations = [{version: 37}];\n");
  write(
    "dist/persistence/native-conversation-store.js",
    'export const nativeConversationSchemaVersion = 11; export class NativeConversationStore { constructor(filename) { if (!filename.endsWith("native-schema.sqlite")) throw new Error("The native schema probe must use an isolated file"); } close() {} } export function readNativeConversationSchemaVersion() { return 11; }\n',
  );
  write(
    "node_modules/better-sqlite3/package.json",
    JSON.stringify({
      exports: { ".": "./index.cjs", "./package.json": "./package.json" },
      name: "better-sqlite3",
      version: "13.0.1",
    }),
  );
  write(
    "node_modules/better-sqlite3/index.cjs",
    'module.exports = class Database { constructor(filename) { if (filename !== ":memory:" && !filename.endsWith("legacy-schema.sqlite")) throw new Error("The native probe must use an isolated location"); } prepare(sql) { return { get() { if (sql.includes("MAX(version)")) return { version: 37 }; if (sql.includes("runtime_owner")) return { name: "runtime_owner" }; return { ready: 1 }; } }; } close() {} };\n',
  );
  write(
    "node_modules/@openai/codex/package.json",
    JSON.stringify({
      bin: { codex: "bin/codex.js" },
      name: "@openai/codex",
      type: "module",
      version: "0.155.1",
    }),
  );
  write(
    "node_modules/@openai/codex/bin/codex.js",
    'if (process.argv[2] !== "--version") throw new Error("No model command may run in the smoke test"); process.stdout.write("codex-cli 0.155.1\\n");\n',
  );
  return { root, write };
}

describe("portable runtime dependency verification", () => {
  it("executes retained migrations and native schema creation with the real portable SQLite binding", () => {
    const { root, write } = fixture();
    for (const name of ["better-sqlite3", "arktype"]) {
      let moduleDirectory = path.dirname(fileURLToPath(import.meta.resolve(name)));
      while (!existsSync(path.join(moduleDirectory, "package.json"))) {
        const parent = path.dirname(moduleDirectory);
        if (parent === moduleDirectory)
          throw new Error("Portable dependency metadata was not found");
        moduleDirectory = parent;
      }
      cpSync(path.dirname(moduleDirectory), path.join(root, "node_modules"), {
        recursive: true,
        dereference: true,
      });
    }
    for (const relative of [
      "persistence/sqlite",
      "persistence/legacy-schema",
      "persistence/native-conversation-store",
      "slack/redact-sensitive",
      "validation/parse",
    ]) {
      const source = readFileSync(
        path.resolve(import.meta.dirname, `../src/${relative}.ts`),
        "utf8",
      );
      write(`dist/${relative}.js`, stripTypeScriptTypes(source));
    }
    expect(verifyStagedRuntime(root, "0.155.1")).toMatchObject({
      betterSqliteVersion: "13.0.3",
      maximumSchemaVersion: 14,
      maximumNativeSchemaVersion: 2,
    });
  }, 20_000);

  it("loads the fallback CLI and staged schemas without starting the runtime or a model", () => {
    const { root } = fixture();
    expect(verifyStagedRuntime(root, "0.155.1")).toEqual({
      betterSqliteVersion: "13.0.1",
      codexVersion: "0.155.1",
      maximumSchemaVersion: 37,
      maximumNativeSchemaVersion: 11,
    });
  }, 20_000);

  it("rejects a native schema capability that differs from the staged store's observed version", () => {
    const { root, write } = fixture();
    write(
      "dist/persistence/native-conversation-store.js",
      "export const nativeConversationSchemaVersion = 11; export class NativeConversationStore { close() {} } export function readNativeConversationSchemaVersion() { return 10; }\n",
    );
    expect(() => verifyStagedRuntime(root, "0.155.1")).toThrow(
      "native conversation schema did not match",
    );
  }, 20_000);

  it.each(["native-binding", "codex-version", "codex-executable", "compiled-schema"])(
    "rejects a staged payload with a broken %s",
    (scenario) => {
      const { root, write } = fixture();
      if (scenario === "native-binding") {
        write(
          "node_modules/better-sqlite3/index.cjs",
          'module.exports = class Database { constructor() { throw new Error("Synthetic missing native SQLite binding"); } };\n',
        );
      } else if (scenario === "codex-version") {
        write(
          "node_modules/@openai/codex/package.json",
          JSON.stringify({ name: "@openai/codex", version: "0.154.0" }),
        );
      } else if (scenario === "codex-executable") {
        write(
          "node_modules/@openai/codex/bin/codex.js",
          'process.stdout.write("codex-cli 0.154.0\\n");\n',
        );
      } else {
        write(
          "dist/persistence/sqlite.js",
          'export class SqliteStore { static open() { throw new Error("Synthetic broken staged schema"); } }\n',
        );
      }
      expect(() => verifyStagedRuntime(root, "0.155.1")).toThrow(
        "Staged runtime dependency verification failed",
      );
    },
    20_000,
  );

  it("rejects dependency resolution outside the portable release", () => {
    const { root } = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "synthetic-outside-dependency-"));
    directories.push(outside);
    writeFileSync(
      path.join(outside, "package.json"),
      JSON.stringify({ name: "better-sqlite3", version: "13.0.1" }),
    );
    rmSync(path.join(root, "node_modules", "better-sqlite3"), { recursive: true });
    symlinkSync(outside, path.join(root, "node_modules", "better-sqlite3"));
    expect(() => verifyStagedRuntime(root, "0.155.1")).toThrow("dependencies must resolve inside");
  }, 20_000);
});
