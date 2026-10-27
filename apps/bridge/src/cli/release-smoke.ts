import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type } from "arktype";

import { codexChildEnvironment } from "../runtime/child-environment.js";
import { parseArk } from "../validation/parse.js";

export interface StagedRuntimeEvidence {
  betterSqliteVersion: string;
  codexVersion: string;
  maximumSchemaVersion: number;
  maximumNativeSchemaVersion: number;
}

const evidenceType = type.declare<StagedRuntimeEvidence>().type({
  betterSqliteVersion: "string",
  codexVersion: "string",
  maximumSchemaVersion: "number.integer >= 0",
  maximumNativeSchemaVersion: "number.integer >= 0",
});

const probeSource = `
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = realpathSync(process.argv[1]);
const expectedVersion = process.argv[2];
const nativeSchemaFile = process.argv[3];
const legacySchemaFile = process.argv[4];
const require = createRequire(path.join(root, "package.json"));
function contained(filename) {
  const canonical = realpathSync(filename);
  const relative = path.relative(root, canonical);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Staged runtime dependencies must resolve inside the portable release");
  }
  return canonical;
}
function packageMetadata(name) {
  let filename;
  try {
    filename = require.resolve(name + "/package.json");
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let directory = path.dirname(contained(fileURLToPath(import.meta.resolve(name))));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(directory, "package.json");
      if (existsSync(candidate)) {
        const metadata = JSON.parse(readFileSync(contained(candidate), "utf8"));
        if (metadata.name === name) {
          filename = candidate;
          break;
        }
      }
      const parent = path.dirname(directory);
      if (directory === root || directory === parent) break;
      directory = parent;
    }
  }
  if (filename === undefined) throw new Error("Staged dependency metadata is unavailable: " + name);
  filename = contained(filename);
  const metadata = JSON.parse(readFileSync(filename, "utf8"));
  if (metadata.name !== name || typeof metadata.version !== "string") {
    throw new Error("Staged dependency metadata does not identify " + name);
  }
  return { directory: path.dirname(filename), metadata };
}
const sqlite = packageMetadata("better-sqlite3");
const codex = packageMetadata("@openai/codex");
if (codex.metadata.version !== expectedVersion) {
  throw new Error("Staged Codex resolved version does not match the pinned release version");
}
const Database = require(contained(require.resolve("better-sqlite3")));
const database = new Database(":memory:");
try {
  const row = database.prepare("SELECT 1 AS ready").get();
  if (row?.ready !== 1) throw new Error("Staged native SQLite query failed");
} finally {
  database.close();
}
const binary = codex.metadata.bin?.codex;
if (typeof binary !== "string") throw new Error("Staged Codex executable is unavailable");
const version = spawnSync(process.execPath, [contained(path.resolve(codex.directory, binary)), "--version"], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
  timeout: 10000,
  maxBuffer: 65536,
});
if (version.status !== 0 || version.stdout.trim() !== "codex-cli " + expectedVersion) {
  const outcome = version.signal === null ? "exit status " + version.status : "signal " + version.signal;
  throw new Error("Staged Codex executable did not confirm its pinned version: " + (version.stderr || version.stdout || version.error?.message || outcome));
}
const { SqliteStore } = await import(pathToFileURL(contained(path.join(root, "dist", "persistence", "sqlite.js"))).href);
const { legacyMigrations } = await import(pathToFileURL(contained(path.join(root, "dist", "persistence", "legacy-schema.js"))).href);
const expectedSchemaVersion = Math.max(0, ...legacyMigrations.map((migration) => migration.version));
if (!Number.isSafeInteger(expectedSchemaVersion)) throw new Error("Staged historical schema version could not be verified");
const store = SqliteStore.open(legacySchemaFile);
store.close();
const legacyDatabase = new Database(legacySchemaFile, { readonly: true, fileMustExist: true });
let maximumSchemaVersion;
try {
  const row = legacyDatabase.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  maximumSchemaVersion = row?.version;
  if (!Number.isSafeInteger(maximumSchemaVersion) || maximumSchemaVersion !== expectedSchemaVersion) {
    throw new Error("Staged historical schema did not match its supported version");
  }
  if (legacyDatabase.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_owner'").get()?.name !== "runtime_owner") {
    throw new Error("Staged runtime ownership schema is unavailable");
  }
} finally {
  legacyDatabase.close();
}
const nativeSchema = await import(pathToFileURL(contained(path.join(root, "dist", "persistence", "native-conversation-store.js"))).href);
const nativeStore = new nativeSchema.NativeConversationStore(nativeSchemaFile);
let maximumNativeSchemaVersion;
try {
  maximumNativeSchemaVersion = nativeSchema.readNativeConversationSchemaVersion(nativeSchemaFile);
  if (!Number.isSafeInteger(maximumNativeSchemaVersion) || maximumNativeSchemaVersion < 0 || maximumNativeSchemaVersion !== nativeSchema.nativeConversationSchemaVersion) {
    throw new Error("Staged native conversation schema did not match its supported version");
  }
} finally {
  nativeStore.close();
}
process.stdout.write(JSON.stringify({
  betterSqliteVersion: sqlite.metadata.version,
  codexVersion: codex.metadata.version,
  maximumSchemaVersion,
  maximumNativeSchemaVersion,
}));
`;

export function verifyStagedRuntime(
  directory: string,
  expectedCodexVersion: string,
): StagedRuntimeEvidence {
  if (!/^\d+\.\d+\.\d+$/u.test(expectedCodexVersion)) {
    throw new Error("Staged dependency verification requires an exact pinned Codex version");
  }
  const root = realpathSync(directory);
  const probeHome = mkdtempSync(path.join(tmpdir(), "sambot-release-probe-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        probeSource,
        root,
        expectedCodexVersion,
        path.join(probeHome, "native-schema.sqlite"),
        path.join(probeHome, "legacy-schema.sqlite"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...codexChildEnvironment(),
          CODEX_HOME: path.join(probeHome, "codex"),
          SLACK_CODEX_HOME: path.join(probeHome, "product"),
        },
        maxBuffer: 256_000,
        timeout: 20_000,
      },
    );
    if (result.status !== 0) {
      const outcome =
        result.signal === null ? `exit status ${result.status}` : `signal ${result.signal}`;
      const reason = result.stderr || result.stdout || result.error?.message || outcome;
      throw new Error(`Staged runtime dependency verification failed: ${reason.slice(0, 2_000)}`);
    }
    return parseArk(evidenceType, JSON.parse(result.stdout), "staged runtime dependency evidence");
  } finally {
    rmSync(probeHome, { force: true, recursive: true });
  }
}
