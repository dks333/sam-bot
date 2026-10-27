import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  activateRelease,
  assertRuntimeIdle,
  createReleaseManifest,
  prepareRuntimeSwitch,
  readReleaseManifest,
  restoreRuntimeSelections,
  runtimeActivity,
  selectedRelease,
  sha256,
  verifyRelease,
} from "../src/cli/release-manager.js";
import { NativeConversationStore } from "../src/persistence/native-conversation-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "immutable-runtime-"));
  mkdirSync(path.join(home, "releases"));
  directories.push(home);
  return home;
}

function release(
  home: string,
  releaseId: string,
  maximumSchemaVersion = 11,
  maximumNativeSchemaVersion?: number,
  agentProviders?: ("codex" | "claude")[],
) {
  const directory = path.join(home, "releases", releaseId);
  mkdirSync(path.join(directory, "dist"), { recursive: true });
  writeFileSync(path.join(directory, "dist", "index.js"), "export const ready = true;\n");
  writeFileSync(
    path.join(directory, "package.json"),
    '{"name":"synthetic-runtime","version":"1.0.0","dependencies":{"@openai/codex":"0.155.1"}}\n',
  );
  writeFileSync(path.join(directory, "source-lock.yaml"), "synthetic lockfile\n");
  const manifest = createReleaseManifest({
    codexVersion: "0.155.1",
    createdAt: "2026-10-15T10:00:00.000Z",
    directory,
    maximumSchemaVersion,
    ...(maximumNativeSchemaVersion === undefined ? {} : { maximumNativeSchemaVersion }),
    ...(agentProviders === undefined ? {} : { agentProviders }),
    packageManager: "pnpm@11.9.0",
    policyVersion: "task-controller-v1",
    releaseId,
    sourceClean: true,
    sourceCommit: "a".repeat(40),
    sourceLockHash: sha256("synthetic lockfile\n"),
  });
  return { directory, manifest };
}

function failedNativeDelivery(home: string, provider: "codex" | "claude") {
  const filename = path.join(
    home,
    provider === "claude" ? "native-conversations-claude.sqlite" : "native-conversations.sqlite",
  );
  const store = new NativeConversationStore(filename);
  const eventId = "synthetic-failed-event";
  const claimed = store.claim({
    eventId,
    teamId: "synthetic-team",
    userId: "synthetic-owner",
    channelId: "synthetic-channel",
    threadTs: "1.0",
    messageTs: "1.1",
    text: "Inspect the synthetic source",
  });
  if (claimed === undefined) throw new Error("Synthetic delivery was not claimed");
  store.bind(claimed.conversationKey, "synthetic-session", home);
  store.dispatch(eventId);
  store.started(eventId, "synthetic-turn");
  store.complete(eventId, "The synthetic turn was interrupted", "failed");
  store.prepareFinalParts(eventId, ["The synthetic turn was interrupted"]);
  return { filename, store, eventId, conversationKey: claimed.conversationKey };
}

function runtimeHealth(provider: "codex" | "claude") {
  return {
    agentProvider: provider,
    pid: process.pid,
    runtimeOwnerId: "synthetic-runtime-owner",
    ready: true,
    startedAt: "2026-10-22T12:00:00.000Z",
  };
}

function writeRuntimeHealth(home: string, provider: "codex" | "claude"): void {
  writeFileSync(path.join(home, "runtime-health.json"), JSON.stringify(runtimeHealth(provider)));
}

describe("immutable runtime releases", () => {
  it("treats an omitted native schema capability as version zero", () => {
    const staged = release(temporaryHome(), "synthetic-old-native");
    expect(verifyRelease(staged.directory, 11, 0)).toEqual(staged.manifest);
    expect(() => verifyRelease(staged.directory, 11, 1)).toThrow("native conversation schema");
    const compatible = release(temporaryHome(), "synthetic-native-compatible", 11, 1);
    expect(verifyRelease(compatible.directory, 11, 1).maximumNativeSchemaVersion).toBe(1);
  });

  it("refuses a Codex-only release when Claude is configured before changing the runtime selection", () => {
    const home = temporaryHome();
    const codexOnly = release(home, "synthetic-codex-only", 11, 1);
    const compatible = release(home, "synthetic-both-agents", 11, 1, ["codex", "claude"]);
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ runtime: { agentProvider: "claude" } }),
    );
    activateRelease(home, compatible.directory, 11);
    expect(() => activateRelease(home, codexOnly.directory, 11)).toThrow("does not support");
    expect(selectedRelease(home)).toBe(realpathSync(compatible.directory));
    expect(() =>
      prepareRuntimeSwitch({
        databaseFile: path.join(home, "bridge.sqlite"),
        directory: codexOnly.directory,
        home,
        launchAgentFile: path.join(home, "agent.plist"),
      }),
    ).toThrow("does not support");
    expect(existsSync(path.join(home, "drain.json"))).toBe(false);
  });

  it("reads the native schema without migrating it and rejects an incompatible preflight before draining", () => {
    const home = temporaryHome();
    const staged = release(home, "synthetic-old-native");
    const nativeFile = path.join(home, "native-conversations.sqlite");
    const store = new NativeConversationStore(nativeFile);
    store.close();
    const before = sha256(readFileSync(nativeFile));
    expect(runtimeActivity(path.join(home, "bridge.sqlite")).nativeSchemaVersion).toBe(2);
    expect(sha256(readFileSync(nativeFile))).toBe(before);
    expect(() =>
      prepareRuntimeSwitch({
        databaseFile: path.join(home, "bridge.sqlite"),
        directory: staged.directory,
        home,
        launchAgentFile: path.join(home, "agent.plist"),
      }),
    ).toThrow("native conversation schema");
    expect(existsSync(path.join(home, "drain.json"))).toBe(false);
    expect(existsSync(path.join(home, "runtime-current"))).toBe(false);
  });

  it("checks the actual native schema before activation even when an obsolete caller supplies zero", () => {
    const home = temporaryHome();
    const old = release(home, "synthetic-old-native");
    const compatible = release(home, "synthetic-native-compatible", 11, 2);
    const store = new NativeConversationStore(path.join(home, "native-conversations.sqlite"));
    store.close();
    activateRelease(home, compatible.directory, 11);
    expect(() => activateRelease(home, old.directory, 11, 0)).toThrow("native conversation schema");
    expect(selectedRelease(home)).toBe(realpathSync(compatible.directory));
  });

  it("refuses automatic rollback to a prior native version zero release after migration and retains both selections", () => {
    const home = temporaryHome();
    const prior = release(home, "synthetic-prior-native");
    const candidate = release(home, "synthetic-new-native", 11, 1);
    activateRelease(home, prior.directory, 11);
    activateRelease(home, candidate.directory, 11);
    const store = new NativeConversationStore(path.join(home, "native-conversations.sqlite"));
    store.close();
    const drain = '{"requestedAt":"synthetic-retained-drain"}\n';
    writeFileSync(path.join(home, "drain.json"), drain);
    expect(() =>
      restoreRuntimeSelections({
        home,
        failedDirectory: candidate.directory,
        priorCurrent: prior.directory,
        priorSchemaVersion: 11,
        schemaVersion: 11,
        priorNativeSchemaVersion: 0,
        nativeSchemaVersion: 0,
      }),
    ).toThrow("native conversation schema");
    expect(selectedRelease(home)).toBe(realpathSync(candidate.directory));
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(prior.directory));
    expect(readFileSync(path.join(home, "drain.json"), "utf8")).toBe(drain);
  });

  it("allows rollback only when the prior release supports the current native schema", () => {
    const home = temporaryHome();
    const prior = release(home, "synthetic-prior-compatible", 11, 2);
    const candidate = release(home, "synthetic-new-native", 11, 2);
    const store = new NativeConversationStore(path.join(home, "native-conversations.sqlite"));
    store.close();
    activateRelease(home, prior.directory, 11);
    activateRelease(home, candidate.directory, 11);
    restoreRuntimeSelections({
      home,
      failedDirectory: candidate.directory,
      priorCurrent: prior.directory,
      priorSchemaVersion: 11,
      schemaVersion: 11,
      priorNativeSchemaVersion: 2,
      nativeSchemaVersion: 2,
    });
    expect(selectedRelease(home)).toBe(realpathSync(prior.directory));
  });

  it("rejects corrupt activation candidates before changing intake or runtime selection", () => {
    const home = temporaryHome();
    const staged = release(home, "synthetic-candidate");
    writeFileSync(
      path.join(staged.directory, "dist", "index.js"),
      "export const changed = true;\n",
    );
    const launchAgentFile = path.join(home, "synthetic-agent.plist");
    writeFileSync(launchAgentFile, "synthetic unchanged agent");
    expect(() =>
      prepareRuntimeSwitch({
        databaseFile: path.join(home, "bridge.sqlite"),
        directory: staged.directory,
        home,
        launchAgentFile,
      }),
    ).toThrow("payload verification");
    expect(existsSync(path.join(home, "drain.json"))).toBe(false);
    expect(existsSync(path.join(home, "runtime-current"))).toBe(false);
    expect(readFileSync(launchAgentFile, "utf8")).toBe("synthetic unchanged agent");
  });

  it("restores accepting intake after busy preflight rejection and preserves an existing drain marker", () => {
    const home = temporaryHome();
    const staged = release(home, "synthetic-candidate");
    const databaseFile = path.join(home, "bridge.sqlite");
    const database = new Database(databaseFile);
    database.exec(
      "CREATE TABLE active_runs (event_id TEXT); INSERT INTO active_runs VALUES ('synthetic-active');",
    );
    database.close();
    const input = {
      databaseFile,
      directory: staged.directory,
      home,
      launchAgentFile: path.join(home, "synthetic-agent.plist"),
    };
    const drainFile = path.join(home, "drain.json");
    expect(() => prepareRuntimeSwitch(input)).toThrow("Refusing");
    expect(existsSync(drainFile)).toBe(false);
    const existing = '{"requestedAt":"synthetic-existing-drain","owner":"synthetic-operator"}\n';
    writeFileSync(drainFile, existing);
    expect(() => prepareRuntimeSwitch(input)).toThrow("Refusing");
    expect(readFileSync(drainFile, "utf8")).toBe(existing);
    expect(existsSync(path.join(home, "runtime-current"))).toBe(false);
  });

  it("prepares a verified idle switch without selecting a release or overwriting existing drain contents", () => {
    const home = temporaryHome();
    const current = release(home, "synthetic-current");
    const previous = release(home, "synthetic-previous");
    const candidate = release(home, "synthetic-candidate");
    symlinkSync(current.directory, path.join(home, "runtime-current"));
    symlinkSync(previous.directory, path.join(home, "runtime-previous"));
    const launchAgentFile = path.join(home, "synthetic-agent.plist");
    writeFileSync(launchAgentFile, "synthetic current agent");
    const drainFile = path.join(home, "drain.json");
    const existing = '{"requestedAt":"synthetic-existing-drain"}\n';
    writeFileSync(drainFile, existing);
    const prepared = prepareRuntimeSwitch({
      databaseFile: path.join(home, "bridge.sqlite"),
      directory: candidate.directory,
      home,
      launchAgentFile,
    });
    expect(prepared).toMatchObject({
      previous: realpathSync(current.directory),
      previousSelection: realpathSync(previous.directory),
      wasDraining: true,
    });
    expect(prepared.previousPlist?.toString()).toBe("synthetic current agent");
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
    expect(readFileSync(drainFile, "utf8")).toBe(existing);
    expect(readFileSync(launchAgentFile, "utf8")).toBe("synthetic current agent");
  });

  it("restores both prior managed selections without retaining the failed candidate as previous", () => {
    const home = temporaryHome();
    const current = release(home, "synthetic-current", 11);
    const previous = release(home, "synthetic-previous", 7);
    const candidate = release(home, "synthetic-candidate", 12);
    activateRelease(home, previous.directory, 7);
    activateRelease(home, current.directory, 11);
    activateRelease(home, candidate.directory, 11);
    const input = {
      failedDirectory: candidate.directory,
      home,
      priorCurrent: current.directory,
      priorPrevious: previous.directory,
      priorSchemaVersion: 11,
      schemaVersion: 11,
    };
    restoreRuntimeSelections(input);
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(previous.directory));
    restoreRuntimeSelections(input);
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(previous.directory));
    expect(existsSync(candidate.directory)).toBe(true);
  });

  it("removes only a failed first managed selection when legacy schema is unchanged", () => {
    const home = temporaryHome();
    const candidate = release(home, "synthetic-candidate");
    const previous = release(home, "synthetic-retained");
    mkdirSync(path.join(home, "runtime"));
    writeFileSync(path.join(home, "runtime", "legacy.txt"), "synthetic legacy runtime");
    const drain = '{"requestedAt":"synthetic-rollback-drain"}\n';
    writeFileSync(path.join(home, "drain.json"), drain);
    symlinkSync(previous.directory, path.join(home, "runtime-previous"));
    activateRelease(home, candidate.directory, 7);
    restoreRuntimeSelections({
      failedDirectory: candidate.directory,
      home,
      priorPrevious: previous.directory,
      priorSchemaVersion: 7,
      schemaVersion: 7,
    });
    expect(existsSync(path.join(home, "runtime-current"))).toBe(false);
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(previous.directory));
    expect(readFileSync(path.join(home, "runtime", "legacy.txt"), "utf8")).toBe(
      "synthetic legacy runtime",
    );
    expect(readFileSync(path.join(home, "drain.json"), "utf8")).toBe(drain);
    expect(existsSync(candidate.directory)).toBe(true);
  });

  it("removes an activation-created previous link when the prior selection had none", () => {
    const home = temporaryHome();
    const current = release(home, "synthetic-current");
    const candidate = release(home, "synthetic-candidate");
    activateRelease(home, current.directory, 11);
    activateRelease(home, candidate.directory, 11);
    restoreRuntimeSelections({
      failedDirectory: candidate.directory,
      home,
      priorCurrent: current.directory,
      priorSchemaVersion: 11,
      schemaVersion: 11,
    });
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
    expect(existsSync(path.join(home, "runtime-previous"))).toBe(false);
  });

  it.each(["runtime-current", "runtime-previous"])(
    "rejects an unexpected %s selection before restoring either link",
    (selection) => {
      const home = temporaryHome();
      const current = release(home, "synthetic-current");
      const previous = release(home, "synthetic-previous");
      const candidate = release(home, "synthetic-candidate");
      const unrelated = release(home, "synthetic-unrelated");
      activateRelease(home, previous.directory, 11);
      activateRelease(home, current.directory, 11);
      activateRelease(home, candidate.directory, 11);
      unlinkSync(path.join(home, selection));
      symlinkSync(unrelated.directory, path.join(home, selection));
      const beforeCurrent = selectedRelease(home);
      const beforePrevious = selectedRelease(home, "runtime-previous");
      expect(() =>
        restoreRuntimeSelections({
          failedDirectory: candidate.directory,
          home,
          priorCurrent: current.directory,
          priorPrevious: previous.directory,
          priorSchemaVersion: 11,
          schemaVersion: 11,
        }),
      ).toThrow("selections changed");
      expect(selectedRelease(home)).toBe(beforeCurrent);
      expect(selectedRelease(home, "runtime-previous")).toBe(beforePrevious);
    },
  );

  it("refuses legacy restoration after schema advancement and preserves the failed selection", () => {
    const home = temporaryHome();
    const candidate = release(home, "synthetic-candidate", 12);
    activateRelease(home, candidate.directory, 7);
    expect(() =>
      restoreRuntimeSelections({
        failedDirectory: candidate.directory,
        home,
        priorSchemaVersion: 7,
        schemaVersion: 12,
      }),
    ).toThrow("legacy runtime was refused");
    expect(selectedRelease(home)).toBe(realpathSync(candidate.directory));
    expect(selectedRelease(home, "runtime-previous")).toBeUndefined();
  });

  it("verifies the prior current release can read the schema before restoring links", () => {
    const home = temporaryHome();
    const current = release(home, "synthetic-current", 11);
    const candidate = release(home, "synthetic-candidate", 12);
    activateRelease(home, current.directory, 11);
    activateRelease(home, candidate.directory, 11);
    expect(() =>
      restoreRuntimeSelections({
        failedDirectory: candidate.directory,
        home,
        priorCurrent: current.directory,
        priorSchemaVersion: 11,
        schemaVersion: 12,
      }),
    ).toThrow("database schema");
    expect(selectedRelease(home)).toBe(realpathSync(candidate.directory));
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(current.directory));
  });

  it("restores the previous link if activation failed before replacing current", () => {
    const home = temporaryHome();
    const current = release(home, "synthetic-current");
    const previous = release(home, "synthetic-previous");
    const candidate = release(home, "synthetic-candidate");
    symlinkSync(current.directory, path.join(home, "runtime-current"));
    symlinkSync(current.directory, path.join(home, "runtime-previous"));
    restoreRuntimeSelections({
      failedDirectory: candidate.directory,
      home,
      priorCurrent: current.directory,
      priorPrevious: previous.directory,
      priorSchemaVersion: 11,
      schemaVersion: 11,
    });
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(previous.directory));
  });

  it("hashes the staged payload and rejects changed or extra files", () => {
    const home = temporaryHome();
    const staged = release(home, "release-1");
    expect(verifyRelease(staged.directory, 11)).toEqual(staged.manifest);
    writeFileSync(
      path.join(staged.directory, "dist", "index.js"),
      "export const changed = true;\n",
    );
    expect(() => verifyRelease(staged.directory, 11)).toThrow("payload verification");
    const another = release(home, "release-2");
    writeFileSync(path.join(another.directory, "injected.js"), "export const unexpected = true;\n");
    expect(() => verifyRelease(another.directory, 11)).toThrow("payload verification");
  });

  it("switches current atomically, retains previous releases and leaves the legacy directory intact", () => {
    const home = temporaryHome();
    const first = release(home, "release-1");
    const second = release(home, "release-2");
    mkdirSync(path.join(home, "runtime"));
    writeFileSync(path.join(home, "runtime", "legacy.txt"), "preserved");
    activateRelease(home, first.directory, 11);
    activateRelease(home, second.directory, 11);
    expect(selectedRelease(home)).toBe(realpathSync(second.directory));
    expect(selectedRelease(home, "runtime-previous")).toBe(realpathSync(first.directory));
    expect(readFileSync(path.join(home, "runtime", "legacy.txt"), "utf8")).toBe("preserved");
    activateRelease(home, first.directory, 11);
    expect(selectedRelease(home)).toBe(realpathSync(first.directory));
    expect(existsSync(second.directory)).toBe(true);
  });

  it("refuses rollback when the target cannot read the current schema", () => {
    const home = temporaryHome();
    const current = release(home, "release-current", 11);
    const old = release(home, "release-old", 9);
    activateRelease(home, current.directory, 11);
    expect(() => activateRelease(home, old.directory, 11)).toThrow("database schema");
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
  });

  it("rejects unreviewed source metadata and external payload symlinks", () => {
    const home = temporaryHome();
    const staged = release(home, "release-1");
    expect(() =>
      createReleaseManifest({
        ...staged.manifest,
        directory: staged.directory,
        sourceClean: false,
      }),
    ).toThrow("clean source");
    writeFileSync(path.join(home, "outside.js"), "export const outside = true;\n");
    symlinkSync(path.join(home, "outside.js"), path.join(staged.directory, "external.js"));
    expect(() => verifyRelease(staged.directory, 11)).toThrow("outside");
  });

  it("rejects selections outside managed releases", () => {
    const home = temporaryHome();
    const outside = path.join(home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(home, "runtime-current"));
    expect(() => selectedRelease(home)).toThrow("outside managed");
    expect(existsSync(outside)).toBe(true);
  });

  it("checks live activity through a readonly database without running migrations", () => {
    const home = temporaryHome();
    const filename = path.join(home, "bridge.sqlite");
    const database = new Database(filename);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER); INSERT INTO schema_migrations VALUES (7); CREATE TABLE active_runs (event_id TEXT); INSERT INTO active_runs VALUES ('synthetic-run');",
    );
    database.close();
    const before = sha256(readFileSync(filename));
    expect(runtimeActivity(filename)).toMatchObject({ activeRuns: 1, schemaVersion: 7 });
    expect(() => assertRuntimeIdle(filename)).toThrow("Refusing");
    expect(sha256(readFileSync(filename))).toBe(before);
  });

  it("also blocks active queued tasks and native approvals without legacy active rows", () => {
    const home = temporaryHome();
    const filename = path.join(home, "bridge.sqlite");
    const database = new Database(filename);
    database.exec(
      "CREATE TABLE task_queue (state TEXT); INSERT INTO task_queue VALUES ('queued'); CREATE TABLE task_pending_inputs (state TEXT, expires_at TEXT); INSERT INTO task_pending_inputs VALUES ('pending', '2999-01-01T00:00:00.000Z');",
    );
    database.close();
    expect(runtimeActivity(filename)).toMatchObject({ pendingInputs: 1, queuedTasks: 1 });
    expect(() => assertRuntimeIdle(filename)).toThrow("Refusing");
  });

  it.each([
    {
      evidence: "a canceled task with an unresolved cancellation fence",
      table: "tasks",
      state: "cancelled",
      payload: { phase: "cancellation-unconfirmed" },
    },
    {
      evidence: "a failed command without a numeric process exit",
      table: "task_commands",
      state: "failed",
      payload: { nativeItemId: "synthetic-command", processHandle: "synthetic-process" },
    },
    {
      evidence: "a failed command with a string process exit",
      table: "task_commands",
      state: "failed",
      payload: { exitCode: "0" },
    },
    {
      evidence: "a canceled task whose reviewer still owns unconfirmed execution",
      table: "tasks",
      state: "cancelled",
      payload: {
        phase: "cancelled",
        reviewReceipts: [{ cancellationUnconfirmed: true, nativeThreadId: "synthetic-review" }],
      },
    },
    {
      evidence: "a failed managed check without process termination evidence",
      table: "task_managed_checks",
      state: "failed",
      payload: { executionId: "synthetic-check" },
    },
    {
      evidence: "an unknown managed check despite a numeric exit field",
      table: "task_managed_checks",
      state: "unknown",
      payload: { exitCode: 0 },
    },
  ])(
    "blocks release replacement for retained legacy evidence: $evidence",
    ({ table, state, payload }) => {
      const home = temporaryHome();
      const filename = path.join(home, "bridge.sqlite");
      const database = new Database(filename);
      database.exec(`CREATE TABLE ${table} (state TEXT, payload_json TEXT)`);
      database
        .prepare(`INSERT INTO ${table}(state,payload_json) VALUES(?,?)`)
        .run(state, JSON.stringify(payload));
      database.close();
      const before = sha256(readFileSync(filename));
      expect(runtimeActivity(filename)).toMatchObject({
        activeRuns: 0,
        activeTasks: 0,
        unresolvedExecutions: 1,
      });
      expect(() => assertRuntimeIdle(filename)).toThrow("unconfirmed executions");
      expect(sha256(readFileSync(filename))).toBe(before);
      const settlement = new Database(filename);
      settlement.prepare(`UPDATE ${table} SET state='failed',payload_json=?`).run(
        JSON.stringify({
          phase: "cancelled",
          reviewReceipts: [{ cancellationUnconfirmed: false }],
          exitCode: 0,
        }),
      );
      settlement.close();
      expect(assertRuntimeIdle(filename).unresolvedExecutions).toBe(0);
    },
  );

  it.each(["task_commands", "task_managed_checks"])(
    "does not invent running work for proven never-launched historical %s entries",
    (table) => {
      const home = temporaryHome();
      const filename = path.join(home, "bridge.sqlite");
      const database = new Database(filename);
      database.exec(`CREATE TABLE ${table} (state TEXT, payload_json TEXT)`);
      database
        .prepare(`INSERT INTO ${table}(state,payload_json) VALUES(?,?)`)
        .run("failed", JSON.stringify({ neverLaunched: true }));
      database.close();
      expect(assertRuntimeIdle(filename).unresolvedExecutions).toBe(0);
    },
  );

  it("includes active work and pending delivery from either agent ledger before switching releases", () => {
    const home = temporaryHome();
    const databaseFile = path.join(home, "bridge.sqlite");
    const stores = ["native-conversations.sqlite", "native-conversations-claude.sqlite"].map(
      (filename) => new NativeConversationStore(path.join(home, filename)),
    );
    try {
      for (const [index, store] of stores.entries()) {
        const eventId = `synthetic-event-${index}`;
        const delivery = store.claim({
          eventId,
          teamId: "synthetic-team",
          userId: "synthetic-owner",
          channelId: "synthetic-channel",
          threadTs: "1.0",
          messageTs: "1.1",
          text: "Explain the synthetic source",
        });
        if (delivery === undefined) throw new Error("Synthetic delivery was not claimed");
        store.bind(delivery.conversationKey, `synthetic-session-${index}`, home);
        store.dispatch(eventId);
        store.started(eventId, `synthetic-turn-${index}`);
      }
      expect(runtimeActivity(databaseFile)).toMatchObject({
        activeRuns: 2,
        nativeSchemaVersion: 2,
      });
      expect(() => assertRuntimeIdle(databaseFile)).toThrow("Refusing");
      for (const [index, store] of stores.entries())
        store.complete(`synthetic-event-${index}`, "Synthetic result", "completed");
      expect(runtimeActivity(databaseFile)).toMatchObject({ activeRuns: 0, delivering: 2 });
      expect(() => assertRuntimeIdle(databaseFile)).toThrow("Refusing");
      for (const [index, store] of stores.entries())
        store.delivered(`synthetic-event-${index}`, `synthetic-receipt-${index}`);
      expect(assertRuntimeIdle(databaseFile)).toMatchObject({ activeRuns: 0, delivering: 0 });
    } finally {
      for (const store of stores) store.close();
    }
  });

  it("checks the Claude ledger schema before activating an incompatible release", () => {
    const home = temporaryHome();
    const old = release(home, "synthetic-old-release");
    const store = new NativeConversationStore(
      path.join(home, "native-conversations-claude.sqlite"),
    );
    store.close();
    expect(() => activateRelease(home, old.directory, 11)).toThrow("native conversation schema");
    expect(existsSync(path.join(home, "runtime-current"))).toBe(false);
  });

  it("ignores revoked pending output in both ledgers while retaining unknown execution blockers", () => {
    const home = temporaryHome();
    const databaseFile = path.join(home, "bridge.sqlite");
    const stores = ["native-conversations.sqlite", "native-conversations-claude.sqlite"].map(
      (filename) => new NativeConversationStore(path.join(home, filename)),
    );
    try {
      for (const [index, store] of stores.entries()) {
        const current = store.claim({
          eventId: `synthetic-revoked-${index}`,
          teamId: "synthetic-team",
          userId: "synthetic-owner",
          channelId: "synthetic-channel",
          threadTs: "1.0",
          messageTs: "1.1",
          text: "Synthetic retained request",
        });
        if (current === undefined) throw new Error("Expected synthetic claim");
        store.bind(current.conversationKey, `synthetic-native-${index}`, home);
        store.dispatch(current.eventId);
        store.started(current.eventId, `synthetic-turn-${index}`);
        if (index === 0) store.complete(current.eventId, "Synthetic final", "completed");
        store.revokeUnauthorized(() => false);
      }
      expect(runtimeActivity(databaseFile)).toMatchObject({
        delivering: 0,
        unresolvedExecutions: 1,
        nativeSchemaVersion: 2,
      });
      expect(() => assertRuntimeIdle(databaseFile)).toThrow("Refusing");
      const unknown = stores[1];
      if (unknown === undefined) throw new Error("Expected synthetic inactive ledger");
      const conversation = unknown.listConversations()[0];
      if (conversation?.threadId === undefined || conversation.activeTurnId === undefined)
        throw new Error("Expected retained execution evidence");
      unknown.reconcileTerminal(conversation.key, conversation.threadId, conversation.activeTurnId);
      expect(assertRuntimeIdle(databaseFile)).toMatchObject({
        delivering: 0,
        unresolvedExecutions: 0,
      });
    } finally {
      for (const store of stores) store.close();
    }
  });

  it("blocks rollback to a version-one native writer after access revocation is persisted", () => {
    const home = temporaryHome();
    const old = release(home, "synthetic-version-one", 11, 1);
    const current = release(home, "synthetic-version-two", 11, 2);
    activateRelease(home, old.directory, 11);
    activateRelease(home, current.directory, 11);
    const store = new NativeConversationStore(path.join(home, "native-conversations.sqlite"));
    store.close();
    expect(() =>
      restoreRuntimeSelections({
        home,
        failedDirectory: current.directory,
        priorCurrent: old.directory,
        priorSchemaVersion: 11,
        schemaVersion: 11,
        priorNativeSchemaVersion: 1,
        nativeSchemaVersion: 2,
      }),
    ).toThrow("native conversation schema");
    expect(selectedRelease(home)).toBe(realpathSync(current.directory));
  });

  it.each(["codex", "claude"])(
    "retains an inactive failed final without replay or state changes when %s is selected",
    (selectedProvider) => {
      const home = temporaryHome();
      const inactiveProvider = selectedProvider === "codex" ? "claude" : "codex";
      writeFileSync(
        path.join(home, "config.json"),
        JSON.stringify({ runtime: { agentProvider: selectedProvider } }),
      );
      writeRuntimeHealth(home, inactiveProvider === "claude" ? "codex" : "claude");
      const { filename, store, eventId, conversationKey } = failedNativeDelivery(
        home,
        inactiveProvider,
      );
      try {
        const before = {
          delivery: store.getDelivery(eventId),
          parts: store.getFinalParts(eventId),
          conversation: store.getConversation(conversationKey),
          database: sha256(readFileSync(filename)),
          wal: sha256(readFileSync(`${filename}-wal`)),
        };
        expect(assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toMatchObject({
          activeRuns: 0,
          queuedTasks: 0,
          unresolvedExecutions: 0,
          delivering: 0,
        });
        expect({
          delivery: store.getDelivery(eventId),
          parts: store.getFinalParts(eventId),
          conversation: store.getConversation(conversationKey),
          database: sha256(readFileSync(filename)),
          wal: sha256(readFileSync(`${filename}-wal`)),
        }).toEqual(before);
        writeFileSync(
          path.join(home, "config.json"),
          JSON.stringify({ runtime: { agentProvider: inactiveProvider } }),
        );
        expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({ delivering: 1 });
        expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
        expect(store.getDelivery(eventId)).toEqual(before.delivery);
        expect(store.getFinalParts(eventId)).toEqual(before.parts);
      } finally {
        store.close();
      }
    },
  );

  it.each(["sending", "uncertain"])(
    "blocks an inactive failed final whose Slack delivery is %s",
    (state) => {
      const home = temporaryHome();
      writeRuntimeHealth(home, "codex");
      const { store, eventId } = failedNativeDelivery(home, "claude");
      try {
        store.beginFinalPart(eventId, 0);
        if (state === "uncertain") store.uncertainFinalPart(eventId, 0);
        expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({ delivering: 1 });
        expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
      } finally {
        store.close();
      }
    },
  );

  it("blocks inactive queued work even when a previous failed final can be deferred", () => {
    const home = temporaryHome();
    writeRuntimeHealth(home, "codex");
    const { store } = failedNativeDelivery(home, "claude");
    try {
      store.claim({
        eventId: "synthetic-next-event",
        teamId: "synthetic-team",
        userId: "synthetic-owner",
        channelId: "synthetic-channel",
        threadTs: "1.0",
        messageTs: "1.2",
        text: "Explain another synthetic source",
      });
      expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({ queuedTasks: 1 });
      expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
    } finally {
      store.close();
    }
  });

  it("blocks running or uncertain inactive work and retains its pending finals as blockers", () => {
    const home = temporaryHome();
    writeRuntimeHealth(home, "codex");
    const { store } = failedNativeDelivery(home, "claude");
    try {
      const eventId = "synthetic-next-event";
      store.claim({
        eventId,
        teamId: "synthetic-team",
        userId: "synthetic-owner",
        channelId: "synthetic-channel",
        threadTs: "1.0",
        messageTs: "1.2",
        text: "Explain another synthetic source",
      });
      store.dispatch(eventId);
      store.started(eventId, "synthetic-next-turn");
      expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({
        activeRuns: 1,
        delivering: 1,
      });
      expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
      store.complete(eventId, "Synthetic terminal evidence is unavailable", "uncertain");
      expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({
        activeRuns: 0,
        unresolvedExecutions: 1,
        delivering: 2,
      });
      expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
    } finally {
      store.close();
    }
  });

  it.each(["unverified failure", "missing delivery evidence"])(
    "blocks an inactive final with %s",
    (condition) => {
      const home = temporaryHome();
      writeRuntimeHealth(home, "codex");
      const { filename, store, eventId } = failedNativeDelivery(home, "claude");
      store.close();
      const fixture = new Database(filename);
      if (condition === "unverified failure")
        fixture
          .prepare("UPDATE native_deliveries SET completion_status=NULL WHERE event_id=?")
          .run(eventId);
      else fixture.exec("DROP TABLE native_final_delivery_intents");
      fixture.close();
      expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({ delivering: 1 });
      expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
    },
  );

  it.each([
    { label: "missing health", source: undefined },
    { label: "malformed health", source: "{" },
    { label: "different live provider", source: JSON.stringify(runtimeHealth("claude")) },
    { label: "missing PID", source: JSON.stringify({ ...runtimeHealth("codex"), pid: undefined }) },
    { label: "invalid PID", source: JSON.stringify({ ...runtimeHealth("codex"), pid: 0 }) },
    {
      label: "missing owner identity",
      source: JSON.stringify({ ...runtimeHealth("codex"), runtimeOwnerId: undefined }),
    },
    {
      label: "invalid launch time",
      source: JSON.stringify({ ...runtimeHealth("codex"), startedAt: "invalid" }),
    },
  ])("retains inactive failed delivery blockers with $label", ({ source }) => {
    const home = temporaryHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ runtime: { agentProvider: "codex" } }),
    );
    const { store } = failedNativeDelivery(home, "claude");
    try {
      if (source !== undefined) writeFileSync(path.join(home, "runtime-health.json"), source);
      expect(runtimeActivity(path.join(home, "bridge.sqlite"))).toMatchObject({ delivering: 1 });
      expect(() => assertRuntimeIdle(path.join(home, "bridge.sqlite"))).toThrow("Refusing");
    } finally {
      store.close();
    }
  });

  it("requires matching live ownership and permits prior matching health after ownership is released", () => {
    const home = temporaryHome();
    const { store } = failedNativeDelivery(home, "claude");
    const databaseFile = path.join(home, "bridge.sqlite");
    const ownership = new Database(databaseFile);
    try {
      writeRuntimeHealth(home, "codex");
      ownership.exec("CREATE TABLE runtime_owner (slot INTEGER,owner_id TEXT,pid INTEGER)");
      ownership
        .prepare("INSERT INTO runtime_owner(slot,owner_id,pid) VALUES(1,?,?)")
        .run("synthetic-runtime-owner", process.pid);
      expect(assertRuntimeIdle(databaseFile)).toMatchObject({ delivering: 0 });
      ownership
        .prepare("UPDATE runtime_owner SET owner_id=? WHERE slot=1")
        .run("synthetic-other-owner");
      expect(runtimeActivity(databaseFile)).toMatchObject({ delivering: 1 });
      ownership
        .prepare("UPDATE runtime_owner SET owner_id=?,pid=? WHERE slot=1")
        .run("synthetic-runtime-owner", process.pid + 1);
      expect(runtimeActivity(databaseFile)).toMatchObject({ delivering: 1 });
      ownership.prepare("DELETE FROM runtime_owner WHERE slot=1").run();
      writeFileSync(
        path.join(home, "runtime-health.json"),
        JSON.stringify({ ...runtimeHealth("codex"), ready: false, stopping: true }),
      );
      expect(assertRuntimeIdle(databaseFile)).toMatchObject({ delivering: 0 });
    } finally {
      ownership.close();
      store.close();
    }
  });

  it("retains runtime and schema provenance in the saved manifest", () => {
    const staged = release(temporaryHome(), "release-1");
    expect(readReleaseManifest(staged.directory)).toMatchObject({
      codexVersion: "0.155.1",
      maximumSchemaVersion: 11,
      packageManager: "pnpm@11.9.0",
      sourceCommit: "a".repeat(40),
      sourceLockHash: sha256("synthetic lockfile\n"),
      sourceClean: true,
      version: 1,
    });
  });
});
