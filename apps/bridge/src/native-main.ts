import { existsSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { WebClient } from "@slack/web-api";

import type { ConversationBackend } from "./agents/conversation-backend.js";
import { NativeSlackService } from "./bridge/native-service.js";
import { revokeUnauthorizedDeliveries } from "./bridge/retained-authorization.js";
import { ClaudeConversation } from "./claude/conversation.js";
import { readRuntimeReleaseIdentity } from "./cli/release-manager.js";
import { ProcessAppServerConnection, type AppServerConnection } from "./codex/app-server-client.js";
import { NativeConversation } from "./codex/native-conversation.js";
import type { loadProduct } from "./config/product.js";
import { SqliteStore } from "./persistence/sqlite.js";
import {
  hasNativeDelivery,
  NativeConversationStore,
} from "./persistence/native-conversation-store.js";
import { acquireRuntimeOwner } from "./runtime/runtime-owner.js";
import { RuntimeStartup, registerStartupSignals } from "./runtime/startup-lifecycle.js";
import { createSlackApp } from "./slack/app.js";
import { AgentSessionStatusAdapter } from "./slack/agent-session-status.js";
import { AgentStatusCoordinator } from "./slack/agent-status-coordinator.js";
import { nativeSlackTransport } from "./slack/native-transport.js";
import { redactSensitiveText } from "./slack/redact-sensitive.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startNativeSlack(product: ReturnType<typeof loadProduct>): Promise<void> {
  const config = product.bridge;
  const redactText = (text: string): string =>
    redactSensitiveText(text, [config.botToken, config.appToken]);
  const agentProvider = product.config.runtime.agentProvider ?? "codex";
  const agentName = agentProvider === "claude" ? "Claude Code" : "Codex";
  let executablePath = product.config.codex.executablePath;
  if (agentProvider === "claude") executablePath = product.config.claude?.executablePath;
  if (
    executablePath !== undefined &&
    (!path.isAbsolute(executablePath) || !existsSync(executablePath))
  )
    throw new Error(`Native Slack needs the installed ${agentName} executable path`);
  const alias = config.defaultWorkspaceAlias ?? Object.keys(config.workspaces)[0];
  const cwd = alias === undefined ? undefined : config.workspaces[alias];
  if (cwd === undefined) throw new Error("Native Slack needs a project directory");
  const logger = pino(
    { level: config.logLevel },
    pino.destination({ dest: path.join(product.paths.logsDirectory, "bridge.log"), mkdir: true }),
  );
  const runtimeStore = SqliteStore.open(config.databasePath);
  const otherProviderLedgerFile = path.join(
    product.paths.home,
    agentProvider === "claude"
      ? "native-conversations.sqlite"
      : "native-conversations-claude.sqlite",
  );
  const identity = readRuntimeReleaseIdentity(path.resolve(import.meta.dirname, ".."));
  const startedAt = new Date().toISOString();
  const health: Record<string, unknown> = {
    ...identity,
    pid: process.pid,
    startedAt,
    ready: false,
    mode: "native-conversation",
    agentProvider,
  };
  let stopping = false;
  let shutdown: (() => Promise<void>) | undefined;
  let owner: ReturnType<typeof acquireRuntimeOwner>;
  try {
    owner = acquireRuntimeOwner({
      store: runtimeStore,
      onOwnershipLost(error) {
        logger.error({ error: error.message }, "Native Slack runtime ownership lost");
        process.exitCode = 1;
        void shutdown?.();
      },
    });
  } catch (error) {
    runtimeStore.close();
    throw error;
  }
  let store: NativeConversationStore;
  try {
    store = new NativeConversationStore(
      path.join(
        product.paths.home,
        agentProvider === "claude"
          ? "native-conversations-claude.sqlite"
          : "native-conversations.sqlite",
      ),
    );
  } catch (error) {
    try {
      owner.release();
    } finally {
      runtimeStore.close();
    }
    throw error;
  }
  process.once("exit", () => owner.release());
  function publish(details: Record<string, unknown>): void {
    owner.assertOwned();
    Object.assign(health, details);
    if (identity === undefined) return;
    const filename = path.join(product.paths.home, "runtime-health.json");
    const temporary = `${filename}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(health), { mode: 0o600 });
    renameSync(temporary, filename);
  }
  const startup = new RuntimeStartup({
    assertOwned: () => owner.assertOwned(),
    onPhase: (event) => publish({ startup: event }),
  });
  registerStartupSignals(process, startup, () => shutdown);
  let connection: AppServerConnection | undefined;
  let startupSignal: AbortSignal | undefined;
  const developerInstructions =
    "Your Slack identity is Sam Bot, a coding assistant that connects Slack to Codex and Claude Code on the user's computer. When introducing yourself, give a short, direct answer without a greeting or follow-up question. Your name and persona are defined here and do not require a documentation lookup.";
  let native: ConversationBackend;
  let claude: ClaudeConversation | undefined;
  if (agentProvider === "claude") {
    claude = new ClaudeConversation({
      cwd,
      ...(executablePath === undefined ? {} : { executablePath }),
      ...(product.config.claude?.model === undefined ? {} : { model: product.config.claude.model }),
      developerInstructions,
      stateDirectory: path.join(product.paths.home, "claude"),
    });
    native = claude;
  } else {
    native = new NativeConversation({
      developerInstructions,
      connectionFactory: async () => {
        connection = await ProcessAppServerConnection.create({
          ...(executablePath === undefined ? {} : { executablePath }),
          codexHome: config.codexHome ?? path.join(os.homedir(), ".codex"),
          ...(startupSignal === undefined ? {} : { signal: startupSignal }),
          onStderr: () => logger.debug("Native Codex diagnostic output"),
        });
        return connection;
      },
    });
  }
  let service: NativeSlackService | undefined;
  const app = createSlackApp(config, {
    logger,
    parseCommand: (text) => ({ type: "prompt", prompt: text }),
    store: {
      claimEvent: (eventId) => !hasNativeDelivery(otherProviderLedgerFile, { eventId }),
      claimMessage: (channelId, messageTs) =>
        !hasNativeDelivery(otherProviderLedgerFile, { channelId, messageTs }),
      findTrackedRun: (eventId) => {
        const delivery = store.getDelivery(eventId);
        if (delivery === undefined) return undefined;
        return {
          eventId,
          channelId: delivery.channelId,
          slackThreadTs: delivery.threadTs,
        };
      },
    },
    service: {
      async handleMention(input) {
        if (existsSync(path.join(product.paths.home, "drain.json")))
          throw new Error(`${agentName} is restarting. Please try again shortly.`);
        if (service === undefined) throw new Error(`${agentName} is starting`);
        await service.handleMention(input);
      },
      async handleApproval(input) {
        await service?.handleApproval(input);
      },
      async handleStopRun(input) {
        await service?.handleStopRun(input);
      },
      async handleNewSession(input) {
        await service?.handleNewSession(input);
      },
    },
    onAuthorizedReceipt(receipt) {
      const slack = isRecord(health.slack) ? health.slack : {};
      publish({ slack: { ...slack, receiptVerified: true, lastReceipt: receipt } });
    },
    onConnectionState(connectionState) {
      if (stopping) return;
      const slack = isRecord(health.slack) ? health.slack : {};
      publish({
        ready: health.nativeReady === true && connectionState.connected,
        slack: {
          ...slack,
          socketModeStarted: connectionState.connected,
          connection: connectionState,
        },
      });
    },
  });
  const status = new AgentStatusCoordinator({
    writer: new AgentSessionStatusAdapter(
      new WebClient(config.botToken, {
        timeout: 5_000,
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
      }),
      { assertOwned: () => owner.assertOwned() },
    ),
    logger,
    assertOwned: () => owner.assertOwned(),
    confirmExecuting: (snapshot) =>
      snapshot.nativeTurnId !== undefined &&
      service?.isExecuting(snapshot.conversationKey, snapshot.nativeTurnId) === true,
  });
  service = new NativeSlackService({
    native,
    agentName,
    store,
    cwd,
    authorizationPolicy: config,
    logger,
    transport: nativeSlackTransport(app.client, redactText),
    redactSensitiveText: redactText,
    onActivity: (snapshot) => status.observe(snapshot),
    assertOwned: () => owner.assertOwned(),
    onTransportClosed() {
      try {
        publish({ ready: false, nativeReady: false });
      } catch {
        logger.warn("Runtime health publication was fenced after native closure");
      }
      process.exitCode = 1;
      void shutdown?.();
    },
  });
  let shutdownPromise: Promise<void> | undefined;
  shutdown = () => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    stopping = true;
    startup.cancel("Native Slack is stopping");
    shutdownPromise = (async () => {
      try {
        publish({ ready: false, stopping: true });
      } catch {
        logger.warn("Runtime health publication was fenced during shutdown");
      }
      const results = await Promise.allSettled([app.stop(), service?.shutdown()]);
      if (results.some((result) => result.status === "rejected")) process.exitCode = 1;
      await status.close();
      try {
        owner.release();
      } catch {
        process.exitCode = 1;
      }
      store.close();
      runtimeStore.close();
    })();
    return shutdownPromise;
  };
  try {
    await startup.run("native-initialization", async (signal) => {
      startupSignal = signal;
      await native.start();
      startupSignal = undefined;
    });
    const readiness = await startup.run("native-readiness", async () => {
      if (claude !== undefined) {
        return {
          ...(await claude.readiness()),
          status: "native-ready",
          mode: "subscription",
        };
      }
      if (connection === undefined) throw new Error("Native Codex did not initialize");
      const read = await connection.request("config/read", { cwd, includeLayers: false });
      const models = await connection.request("model/list", { limit: 100 });
      if (!isRecord(read) || !isRecord(read.config) || typeof read.config.model !== "string")
        throw new Error("Native configuration could not be verified");
      const effective = read.config;
      if (
        !isRecord(models) ||
        !Array.isArray(models.data) ||
        !models.data.some((model: unknown) => isRecord(model) && model.model === effective.model)
      )
        throw new Error("Native defaults and configured model could not be verified");
      return {
        status: "native-ready",
        mode: "inherited",
        nativeDefaultsVerified: true,
        modelCatalogueComplete: models.nextCursor === null,
        model: effective.model,
        reasoningEffort: effective.model_reasoning_effort,
        approvalPolicy: effective.approval_policy,
        sandbox: effective.sandbox_mode,
        runtime: connection.runtimeInfo?.(),
      };
    });
    publish({ nativeReadiness: readiness, nativeReady: true, runtimeOwnerId: owner.ownerId });
    await startup.run("recovery", async () => {
      owner.assertOwned();
      if (existsSync(otherProviderLedgerFile)) {
        const otherStore = new NativeConversationStore(otherProviderLedgerFile);
        try {
          revokeUnauthorizedDeliveries(otherStore, config);
        } finally {
          otherStore.close();
        }
      }
      await service.recover();
    });
    await startup.run("slack-connection", async () => {
      await app.init();
      await app.start();
    });
    startup.complete();
    const slack = isRecord(health.slack) ? health.slack : {};
    if (slack.socketModeStarted !== true) throw new Error("Slack did not confirm a connection");
    publish({ ready: true });
    logger.info(
      { agentProvider, executablePath, cwd, readiness },
      "Native Slack transport connected",
    );
  } catch (error) {
    await shutdown();
    throw error;
  }
}
