import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { type } from "arktype";

import { parseArk } from "../validation/parse.js";
import { readNativeConversationSchemaVersion } from "../persistence/native-conversation-store.js";

export interface ReleaseManifest {
  version: 1;
  releaseId: string;
  createdAt: string;
  sourceCommit: string;
  sourceLockHash: string;
  sourceClean: boolean;
  packageManager: string;
  codexVersion: string;
  policyVersion: string;
  maximumSchemaVersion: number;
  maximumNativeSchemaVersion?: number;
  agentProviders?: ("codex" | "claude")[];
  payloadHash: string;
  files: Record<string, string>;
}

const releaseManifestType = type.declare<ReleaseManifest>().type({
  codexVersion: "string",
  createdAt: "string",
  files: { "[string]": "string" },
  maximumSchemaVersion: "number.integer >= 0",
  "maximumNativeSchemaVersion?": "number.integer >= 0",
  "agentProviders?": "('codex' | 'claude')[]",
  packageManager: "string",
  payloadHash: "string",
  policyVersion: "string",
  releaseId: "string",
  sourceClean: "boolean",
  sourceCommit: "string",
  sourceLockHash: "string",
  version: "1",
});

export interface RuntimeActivity {
  schemaVersion: number;
  nativeSchemaVersion: number;
  activeRuns: number;
  activeTasks: number;
  queuedTasks: number;
  pendingInputs: number;
  pendingApprovals: number;
  delivering: number;
  unresolvedExecutions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function payloadFiles(root: string): Record<string, string> {
  const files: [string, string][] = [];
  const canonicalRoot = realpathSync(root);
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const relative = path.relative(root, filename);
      if (relative === "release-manifest.json") {
        continue;
      }
      const entry = lstatSync(filename);
      if (entry.isSymbolicLink()) {
        if (!isWithin(canonicalRoot, realpathSync(filename))) {
          throw new Error("A portable runtime cannot link outside its release directory");
        }
        files.push([relative, sha256(`link:${readlinkSync(filename)}`)]);
      } else if (entry.isDirectory()) {
        visit(filename);
      } else if (entry.isFile()) {
        files.push([relative, sha256(readFileSync(filename))]);
      } else {
        throw new Error("A release payload contains an unsupported filesystem entry");
      }
    }
  };
  visit(root);
  return Object.fromEntries(files);
}

export function createReleaseManifest(
  input: Omit<ReleaseManifest, "version" | "files" | "payloadHash"> & { directory: string },
): ReleaseManifest {
  if (
    !input.sourceClean ||
    !/^[a-f\d]{40}$/u.test(input.sourceCommit) ||
    !/^[a-f\d]{64}$/u.test(input.sourceLockHash)
  ) {
    throw new Error("An immutable release requires verified clean source and lockfile identity");
  }
  if (
    !existsSync(path.join(input.directory, "dist", "index.js")) ||
    !existsSync(path.join(input.directory, "package.json"))
  ) {
    throw new Error("The staged release is missing its runtime entry point or package manifest");
  }
  const { directory, ...metadata } = input;
  verifyReleaseMetadata(directory, metadata);
  const files = payloadFiles(directory);
  const manifest = parseArk(
    releaseManifestType,
    {
      ...metadata,
      files,
      payloadHash: sha256(JSON.stringify(files)),
      version: 1,
    },
    "release manifest",
  );
  writeFileSync(
    path.join(directory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

function verifyReleaseMetadata(
  directory: string,
  metadata: Pick<
    ReleaseManifest,
    "codexVersion" | "sourceCommit" | "sourceLockHash" | "packageManager"
  >,
): void {
  if (
    !/^[a-f\d]{40}$/u.test(metadata.sourceCommit) ||
    !/^[a-f\d]{64}$/u.test(metadata.sourceLockHash) ||
    !/^pnpm@\d+\.\d+\.\d+$/u.test(metadata.packageManager)
  ) {
    throw new Error(
      "Release provenance does not identify exact source, lockfile and package-manager versions",
    );
  }
  const lockfile = path.join(directory, "source-lock.yaml");
  if (!existsSync(lockfile) || sha256(readFileSync(lockfile)) !== metadata.sourceLockHash) {
    throw new Error("The release source lockfile does not match its provenance");
  }
  const parsed: unknown = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  const dependencies = parseArk(
    type({ dependencies: { "@openai/codex": "string" } }),
    parsed,
    "release Codex dependencies",
  );
  if (dependencies.dependencies["@openai/codex"] !== metadata.codexVersion) {
    throw new Error("The release Codex executable version does not match its manifest");
  }
}

export function readReleaseManifest(directory: string): ReleaseManifest {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(directory, "release-manifest.json"), "utf8"),
  );
  return parseArk(releaseManifestType, parsed, "release manifest");
}

export function verifyRelease(
  directory: string,
  schemaVersion: number,
  nativeSchemaVersion = 0,
  agentProvider: "codex" | "claude" = "codex",
): ReleaseManifest {
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 0 ||
    !Number.isSafeInteger(nativeSchemaVersion) ||
    nativeSchemaVersion < 0
  )
    throw new Error("Runtime schema versions must be nonnegative safe integers");
  const manifest = readReleaseManifest(directory);
  verifyReleaseMetadata(directory, manifest);
  if (!(manifest.agentProviders ?? ["codex"]).includes(agentProvider))
    throw new Error(`This release does not support the configured ${agentProvider} agent`);
  if (!manifest.sourceClean || manifest.maximumSchemaVersion < schemaVersion) {
    throw new Error(
      "This release cannot safely read the current database schema; keep the current runtime and repair forward",
    );
  }
  if ((manifest.maximumNativeSchemaVersion ?? 0) < nativeSchemaVersion) {
    throw new Error(
      "This release cannot safely read the current native conversation schema; work is preserved and intake must remain drained for a forward repair",
    );
  }
  const files = payloadFiles(directory);
  if (
    JSON.stringify(files) !== JSON.stringify(manifest.files) ||
    sha256(JSON.stringify(files)) !== manifest.payloadHash
  ) {
    throw new Error(
      "Release payload verification failed; files differ from the immutable manifest",
    );
  }
  return manifest;
}

function nativeConversationFiles(home: string): string[] {
  return ["native-conversations.sqlite", "native-conversations-claude.sqlite"].map((filename) =>
    path.join(home, filename),
  );
}

function readNativeSchemaVersionForHome(home: string): number {
  return Math.max(
    ...nativeConversationFiles(home).map((file) => readNativeConversationSchemaVersion(file) ?? 0),
  );
}

function configuredAgentProvider(home: string): "codex" | "claude" {
  const filename = path.join(home, "config.json");
  if (!existsSync(filename)) return "codex";
  const config: unknown = JSON.parse(readFileSync(filename, "utf8"));
  if (!isRecord(config) || !isRecord(config.runtime))
    throw new Error("The configured agent could not be verified before switching runtimes");
  const provider = config.runtime.agentProvider ?? "codex";
  if (provider !== "codex" && provider !== "claude")
    throw new Error("The configured agent is unsupported");
  return provider;
}

function selectedProviderRuntimeVerified(
  databaseFile: string,
  provider: "codex" | "claude",
): boolean {
  try {
    const health: unknown = JSON.parse(
      readFileSync(path.join(path.dirname(databaseFile), "runtime-health.json"), "utf8"),
    );
    if (
      !isRecord(health) ||
      health.agentProvider !== provider ||
      typeof health.pid !== "number" ||
      !Number.isSafeInteger(health.pid) ||
      health.pid < 1 ||
      typeof health.runtimeOwnerId !== "string" ||
      health.runtimeOwnerId.trim().length === 0 ||
      typeof health.ready !== "boolean" ||
      typeof health.startedAt !== "string" ||
      !Number.isFinite(Date.parse(health.startedAt))
    )
      return false;
    if (!existsSync(databaseFile)) return true;
    const database = new Database(databaseFile, { fileMustExist: true, readonly: true });
    try {
      if (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_owner'")
          .get() === undefined
      )
        return true;
      const owner: unknown = database
        .prepare("SELECT owner_id,pid FROM runtime_owner WHERE slot=1")
        .get();
      if (owner === undefined) return true;
      return (
        isRecord(owner) && owner.pid === health.pid && owner.owner_id === health.runtimeOwnerId
      );
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function addNativeRuntimeActivity(
  activity: RuntimeActivity,
  file: string,
  inactiveProvider: boolean,
): void {
  if (!existsSync(file)) return;
  const database = new Database(file, { fileMustExist: true, readonly: true });
  try {
    database.pragma("query_only = ON");
    database.exec("BEGIN");
    const hasTable = (table: string): boolean =>
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) !== undefined;
    for (const table of ["native_conversations", "native_deliveries"]) {
      if (!hasTable(table)) throw new Error("Native transport activity could not be verified");
    }
    const count = (table: string, predicate: string): number => {
      const row: unknown = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
        .get();
      if (
        !isRecord(row) ||
        typeof row.count !== "number" ||
        !Number.isSafeInteger(row.count) ||
        row.count < 0
      )
        throw new Error("Native transport activity could not be verified");
      return row.count;
    };
    activity.activeRuns += count("native_deliveries", "state IN ('dispatching','running')");
    activity.queuedTasks += count("native_deliveries", "state='queued'");
    let pendingDelivery = "final_text IS NOT NULL AND delivery_message_ts IS NULL";
    if (inactiveProvider && hasTable("native_final_delivery_intents"))
      pendingDelivery += ` AND NOT (
        state='failed' AND completion_status IS 'failed'
        AND EXISTS (
          SELECT 1 FROM native_conversations conversation
          WHERE conversation.key=native_deliveries.conversation_key
            AND conversation.state='idle'
            AND conversation.active_turn_id IS NULL
            AND conversation.active_event_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM native_final_delivery_intents final
          WHERE final.event_id=native_deliveries.event_id
            AND final.state IN ('sending','uncertain')
        )
      )`;
    activity.delivering += count("native_deliveries", pendingDelivery);
    activity.unresolvedExecutions += count("native_conversations", "state='uncertain'");
  } finally {
    database.close();
  }
}

export function runtimeActivity(databaseFile: string, now = new Date()): RuntimeActivity {
  const activity: RuntimeActivity = {
    activeRuns: 0,
    activeTasks: 0,
    delivering: 0,
    pendingApprovals: 0,
    pendingInputs: 0,
    queuedTasks: 0,
    schemaVersion: 0,
    nativeSchemaVersion: readNativeSchemaVersionForHome(path.dirname(databaseFile)),
    unresolvedExecutions: 0,
  };
  const home = path.dirname(databaseFile);
  const selectedProvider = configuredAgentProvider(home);
  const selectedLedger = path.join(
    home,
    selectedProvider === "claude"
      ? "native-conversations-claude.sqlite"
      : "native-conversations.sqlite",
  );
  const runtimeVerified = selectedProviderRuntimeVerified(databaseFile, selectedProvider);
  for (const file of nativeConversationFiles(home))
    addNativeRuntimeActivity(activity, file, runtimeVerified && file !== selectedLedger);
  if (!existsSync(databaseFile)) {
    return activity;
  }
  const database = new Database(databaseFile, { fileMustExist: true, readonly: true });
  try {
    const hasTable = (name: string): boolean =>
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) !== undefined;
    const count = (table: string, predicate = "1 = 1", values: string[] = []): number => {
      if (!hasTable(table)) {
        return 0;
      }
      const row: unknown = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`)
        .get(...values);
      if (!isRecord(row) || typeof row.count !== "number") {
        throw new Error("Runtime activity could not be verified");
      }
      return row.count;
    };
    activity.activeRuns += count("active_runs");
    activity.activeTasks = count(
      "tasks",
      "state IN ('accepted', 'queued', 'running', 'waiting-for-input')",
    );
    activity.queuedTasks += count("task_queue", "state IN ('queued', 'claimed')");
    activity.pendingInputs = count("task_pending_inputs", "state = 'pending' AND expires_at > ?", [
      now.toISOString(),
    ]);
    activity.pendingApprovals = count(
      "pending_approvals",
      "status = 'pending' AND expires_at > ?",
      [now.toISOString()],
    );
    activity.delivering += count(
      "task_outbox",
      "lease_owner IS NOT NULL AND lease_expires_at > ?",
      [now.toISOString()],
    );
    activity.unresolvedExecutions +=
      count("tasks", "json_extract(payload_json, '$.phase') = 'cancellation-unconfirmed'") +
      count(
        "tasks",
        "EXISTS (SELECT 1 FROM json_each(tasks.payload_json, '$.reviewReceipts') receipt WHERE json_extract(receipt.value, '$.cancellationUnconfirmed') = 1)",
      ) +
      count(
        "task_commands",
        "json_extract(payload_json, '$.neverLaunched') IS NOT 1 AND (state = 'running' OR json_type(payload_json, '$.exitCode') IS NOT 'integer')",
      ) +
      count(
        "task_managed_checks",
        "json_extract(payload_json, '$.neverLaunched') IS NOT 1 AND (state IN ('starting', 'running', 'unknown') OR json_type(payload_json, '$.exitCode') IS NOT 'integer')",
      );
    if (hasTable("schema_migrations")) {
      const row: unknown = database
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get();
      if (!isRecord(row) || typeof row.version !== "number") {
        throw new Error("Runtime schema compatibility could not be verified");
      }
      activity.schemaVersion = row.version;
    }
    return activity;
  } finally {
    database.close();
  }
}

export function assertRuntimeIdle(databaseFile: string): RuntimeActivity {
  const activity = runtimeActivity(databaseFile);
  if (
    activity.activeRuns +
      activity.activeTasks +
      activity.queuedTasks +
      activity.pendingInputs +
      activity.pendingApprovals +
      activity.delivering +
      activity.unresolvedExecutions >
    0
  ) {
    throw new Error(
      "Refusing to replace or restart the runtime while tasks, queue entries, approvals, deliveries, or unconfirmed executions remain. Drain current work and reconcile retained process evidence first.",
    );
  }
  return activity;
}

export function prepareRuntimeSwitch(input: {
  databaseFile: string;
  directory: string;
  home: string;
  launchAgentFile: string;
  now?: () => Date;
}): {
  activity: RuntimeActivity;
  previous?: string;
  previousSelection?: string;
  previousPlist?: Buffer;
  wasDraining: boolean;
} {
  const releases = realpathSync(path.join(input.home, "releases"));
  const target = realpathSync(input.directory);
  if (!isWithin(releases, target)) {
    throw new Error("Only a managed immutable release can be prepared for activation");
  }
  const initialActivity = runtimeActivity(input.databaseFile);
  verifyRelease(
    target,
    initialActivity.schemaVersion,
    initialActivity.nativeSchemaVersion,
    configuredAgentProvider(input.home),
  );
  const previous = selectedRelease(input.home);
  const previousSelection = selectedRelease(input.home, "runtime-previous");
  const previousPlist = existsSync(input.launchAgentFile)
    ? readFileSync(input.launchAgentFile)
    : undefined;
  const drainFile = path.join(input.home, "drain.json");
  const wasDraining = existsSync(drainFile);
  if (!wasDraining) {
    writeFileSync(
      drainFile,
      `${JSON.stringify({ requestedAt: (input.now ?? (() => new Date()))().toISOString() })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  }
  try {
    const activity = assertRuntimeIdle(input.databaseFile);
    verifyRelease(
      target,
      activity.schemaVersion,
      activity.nativeSchemaVersion,
      configuredAgentProvider(input.home),
    );
    return {
      activity,
      wasDraining,
      ...(previous === undefined ? {} : { previous }),
      ...(previousSelection === undefined ? {} : { previousSelection }),
      ...(previousPlist === undefined ? {} : { previousPlist }),
    };
  } catch (error) {
    if (!wasDraining) {
      unlinkSync(drainFile);
    }
    throw error;
  }
}

function atomicLink(filename: string, directory: string): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  symlinkSync(
    path.relative(realpathSync(path.dirname(filename)), realpathSync(directory)),
    temporary,
    "dir",
  );
  renameSync(temporary, filename);
}

export function selectedRelease(home: string, selection = "runtime-current"): string | undefined {
  const filename = path.join(home, selection);
  if (!existsSync(filename)) {
    return undefined;
  }
  if (!lstatSync(filename).isSymbolicLink()) {
    throw new Error("Runtime selections must be symbolic links to immutable release directories");
  }
  const directory = realpathSync(filename);
  const releases = realpathSync(path.join(home, "releases"));
  if (!isWithin(releases, directory)) {
    throw new Error("The runtime selection points outside managed releases");
  }
  return directory;
}

export function activateRelease(
  home: string,
  directory: string,
  schemaVersion: number,
  nativeSchemaVersion = 0,
): ReleaseManifest {
  const releases = realpathSync(path.join(home, "releases"));
  const target = realpathSync(directory);
  if (!isWithin(releases, target)) {
    throw new Error("Only a managed immutable release can be activated");
  }
  const actualNativeSchemaVersion = readNativeSchemaVersionForHome(home);
  const manifest = verifyRelease(
    target,
    schemaVersion,
    Math.max(nativeSchemaVersion, actualNativeSchemaVersion),
    configuredAgentProvider(home),
  );
  const previous = selectedRelease(home);
  if (previous !== undefined && previous !== target) {
    atomicLink(path.join(home, "runtime-previous"), previous);
  }
  atomicLink(path.join(home, "runtime-current"), target);
  return manifest;
}

export function restoreRuntimeSelections(input: {
  home: string;
  failedDirectory: string;
  schemaVersion: number;
  priorSchemaVersion: number;
  nativeSchemaVersion?: number;
  priorNativeSchemaVersion?: number;
  priorCurrent?: string;
  priorPrevious?: string;
}): void {
  const releases = realpathSync(path.join(input.home, "releases"));
  const managedDirectory = (directory: string): string => {
    const canonical = realpathSync(directory);
    if (!isWithin(releases, canonical)) {
      throw new Error("Rollback can restore only managed immutable release selections");
    }
    return canonical;
  };
  const target = managedDirectory(input.failedDirectory);
  const priorCurrent =
    input.priorCurrent === undefined ? undefined : managedDirectory(input.priorCurrent);
  const priorPrevious =
    input.priorPrevious === undefined ? undefined : managedDirectory(input.priorPrevious);
  const nativeSchemaVersion = Math.max(
    input.nativeSchemaVersion ?? 0,
    ...nativeConversationFiles(input.home).map(
      (file) => readNativeConversationSchemaVersion(file) ?? 0,
    ),
  );
  if (priorCurrent === undefined && nativeSchemaVersion > (input.priorNativeSchemaVersion ?? 0)) {
    throw new Error(
      "The new runtime changed the native conversation schema. Automatic rollback to the legacy runtime was refused; work is preserved and intake remains drained for a forward repair.",
    );
  }
  if (priorCurrent === undefined && input.schemaVersion > input.priorSchemaVersion) {
    throw new Error(
      "The new runtime changed the database schema. Automatic rollback to the legacy runtime was refused; work is preserved and intake remains drained for a forward repair.",
    );
  }
  const current = selectedRelease(input.home);
  const previous = selectedRelease(input.home, "runtime-previous");
  let activatedPrevious = priorPrevious;
  if (priorCurrent !== undefined && priorCurrent !== target) {
    activatedPrevious = priorCurrent;
  }
  const unchanged = current === priorCurrent && previous === priorPrevious;
  const partiallySwitched = current === priorCurrent && previous === activatedPrevious;
  const switched = current === target && previous === activatedPrevious;
  if (!unchanged && !partiallySwitched && !switched) {
    throw new Error("Runtime selections changed during activation; automatic rollback was refused");
  }
  if (priorCurrent !== undefined) {
    verifyRelease(
      priorCurrent,
      input.schemaVersion,
      nativeSchemaVersion,
      configuredAgentProvider(input.home),
    );
  }
  if (priorPrevious !== undefined) {
    verifyRelease(priorPrevious, 0);
  }
  if (
    selectedRelease(input.home) !== current ||
    selectedRelease(input.home, "runtime-previous") !== previous
  ) {
    throw new Error("Runtime selections changed during activation; automatic rollback was refused");
  }
  if (current !== priorCurrent) {
    if (priorCurrent === undefined) {
      unlinkSync(path.join(input.home, "runtime-current"));
    } else {
      atomicLink(path.join(input.home, "runtime-current"), priorCurrent);
    }
  }
  if (previous !== priorPrevious) {
    if (
      selectedRelease(input.home) !== priorCurrent ||
      selectedRelease(input.home, "runtime-previous") !== previous
    ) {
      throw new Error(
        "Runtime selections changed during activation; automatic rollback was refused",
      );
    }
    if (priorPrevious === undefined) {
      unlinkSync(path.join(input.home, "runtime-previous"));
    } else {
      atomicLink(path.join(input.home, "runtime-previous"), priorPrevious);
    }
  }
}

export function readRuntimeReleaseIdentity(
  directory: string,
): Pick<ReleaseManifest, "releaseId" | "sourceCommit"> | undefined {
  if (!existsSync(path.join(directory, "release-manifest.json"))) {
    return undefined;
  }
  const manifest = readReleaseManifest(directory);
  return { releaseId: manifest.releaseId, sourceCommit: manifest.sourceCommit };
}
