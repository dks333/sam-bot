import type { Logger } from "pino";

import { NativeFinalDelivery } from "./native-final-delivery.js";
export { splitNativeResponse } from "./native-final-delivery.js";

import { composeSlackRequest } from "../slack/request-context.js";

import type { AppServerRequest } from "../codex/app-server-client.js";
import { isUnadmittedNativeSteer } from "../codex/native-conversation.js";
import {
  ConversationSteerUnavailableError,
  ConversationDispatchRejectedError,
  type ConversationBackend,
} from "../agents/conversation-backend.js";
import {
  NativeConversationStore,
  type NativeDelivery,
  type NativeCompletionStatus,
} from "../persistence/native-conversation-store.js";
import { NativeInputRelay } from "../slack/native-input-relay.js";
import type { NativeSlackTransport } from "../slack/native-transport.js";
import type {
  HandleApprovalInput,
  HandleConversationActionInput,
  HandleMentionInput,
} from "./slack-service-contract.js";
import type { NativeActivitySnapshot } from "./native-activity.js";

interface ActiveTurn {
  delivery: NativeDelivery;
  threadId: string;
  turnId?: string;
  items: Map<string, Record<string, unknown>>;
  messages: Map<string, string>;
  finalMessages: Map<string, string>;
  pendingSteers: Set<Promise<void>>;
  completion?: Promise<void>;
  done: Promise<void>;
  resolve: () => void;
  terminal: boolean;
  stopRequested: boolean;
  interrupting?: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conversationKey(input: HandleConversationActionInput): string {
  return JSON.stringify([
    input.identity.teamId,
    input.identity.userId,
    input.identity.channelId,
    input.replyContext.threadTs,
  ]);
}

function slackTimestamp(value: string): bigint | undefined {
  const match = /^(\d{1,20})\.(\d{1,6})$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return BigInt(match[1]) * 1_000_000n + BigInt(match[2].padEnd(6, "0"));
}

async function settleBefore(pending: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class NativeSlackService {
  readonly #native: ConversationBackend;
  readonly #agentName: string;
  readonly #store: NativeConversationStore;
  readonly #transport: NativeSlackTransport;
  readonly #cwd: string;
  readonly #assertOwned: () => void;
  readonly #logger: Pick<Logger, "info" | "warn" | "error">;
  readonly #input: NativeInputRelay;
  readonly #finalDelivery: NativeFinalDelivery;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #delivering = new Map<string, Promise<void>>();
  readonly #onActivity: ((snapshot: NativeActivitySnapshot) => void) | undefined;
  readonly #waitingThreads = new Set<string>();
  readonly #uncertainThreads = new Set<string>();
  #activityRevision = 0;
  #stopping = false;
  #deliveryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: {
    native: ConversationBackend;
    agentName?: string;
    store: NativeConversationStore;
    transport: NativeSlackTransport;
    cwd: string;
    assertOwned: () => void;
    logger: Pick<Logger, "info" | "warn" | "error">;
    onTransportClosed?: () => void;
    onActivity?: (snapshot: NativeActivitySnapshot) => void;
  }) {
    this.#native = options.native;
    this.#agentName = options.agentName ?? "Codex";
    this.#store = options.store;
    this.#transport = options.transport;
    this.#cwd = options.cwd;
    this.#assertOwned = options.assertOwned;
    this.#logger = options.logger;
    this.#onActivity = options.onActivity;
    this.#finalDelivery = new NativeFinalDelivery({
      store: this.#store,
      transport: this.#transport,
      logger: this.#logger,
      assertOwned: () => {
        if (this.#stopping) throw new Error("Native Slack is stopping");
        this.#assertOwned();
      },
    });
    this.#input = new NativeInputRelay({
      agentName: this.#agentName,
      postApproval: (input) => this.#transport.approval(input),
      postInfo: (input) => this.#transport.privateInfo(input),
      onChange: (binding) => {
        const delivery = this.#store.getDelivery(binding.eventId);
        if (delivery === undefined) return;
        if (this.#input.pendingCount(binding) > 0) this.#waitingThreads.add(binding.threadId);
        this.#publishActivity(delivery);
      },
    });
    this.#native.subscribe((message) => {
      if (!isRecord(message)) return;
      if (message.method === "transport/closed") {
        this.#stopping = true;
        this.#input.close();
        for (const active of this.#active.values()) {
          void this.#complete(
            active,
            "uncertain",
            `The ${this.#agentName} connection closed before completion. Its turn has not been replayed.`,
          ).catch((error: unknown) =>
            this.#logger.error({ error }, "Native disconnection could not be persisted"),
          );
        }
        options.onTransportClosed?.();
        return;
      }
      try {
        this.#assertOwned();
        this.#observe(message);
      } catch (error) {
        this.#logger.error({ error }, "Native event could not be processed");
      }
    });
    this.#native.subscribeRequests((request) => this.#request(request));
  }

  async recover(): Promise<void> {
    this.#store.failUncertainOnStartup();
    for (const conversation of this.#store.listConversations()) {
      if (
        conversation.state === "uncertain" &&
        conversation.threadId !== undefined &&
        conversation.activeTurnId !== undefined
      ) {
        try {
          const turn = await this.#native.readTurn(
            conversation.threadId,
            conversation.activeTurnId,
          );
          this.#assertReady();
          if (
            turn !== undefined &&
            ["completed", "failed", "interrupted"].includes(String(turn.status))
          )
            this.#store.reconcileTerminal(
              conversation.key,
              conversation.threadId,
              conversation.activeTurnId,
            );
        } catch (error) {
          this.#logger.warn({ error }, "Native recovery remains uncertain");
        }
      }
      const delivery = this.#store.lastForConversation(conversation.key);
      if (delivery !== undefined) this.#publishActivity(delivery);
    }
    for (const delivery of this.#store.listUnadmitted()) {
      if (delivery.unadmittedTurnId === undefined) continue;
      const conversation = this.#store.getConversation(delivery.conversationKey);
      if (conversation?.state !== "idle") continue;
      try {
        this.#assertReady();
        this.#store.retryUnadmitted(delivery.eventId, delivery.unadmittedTurnId);
        await this.#start(delivery, {});
      } catch (error) {
        this.#logger.warn({ error }, "A retained native instruction could not resume");
        this.#publishActivity(delivery);
      }
    }
    this.#deliveryTimer = setInterval(() => this.#flush(), 5_000);
    this.#deliveryTimer.unref();
    this.#flush();
  }

  async handleMention(input: HandleMentionInput): Promise<void> {
    this.#assertOwned();
    if (this.#stopping)
      throw new Error(`${this.#agentName} is restarting. Please try again shortly.`);
    if (input.command.type !== "prompt")
      throw new Error(`Native ${this.#agentName} requires the original message`);
    const text = input.command.prompt;
    const binding = {
      text,
      teamId: input.identity.teamId,
      userId: input.identity.userId,
      channelId: input.identity.channelId,
      threadTs: input.slackThreadTs,
    };
    const delivery = this.#store.claim({
      ...binding,
      eventId: input.eventId,
      messageTs: input.slackMessageTs,
    });
    if (delivery === undefined) return;
    if (
      /^answer\s+[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:\s|$)/iu.test(
        text.trim(),
      )
    ) {
      const accepted = this.#input.answer(binding);
      if (accepted && this.#linkAnswer(delivery)) return;
      let acknowledgement = `That answer was not sent to ${this.#agentName}. Check the pending question and its answer format, or whether it has expired.`;
      if (accepted) acknowledgement = `Your answer was sent to ${this.#agentName}.`;
      this.#store.complete(delivery.eventId, acknowledgement, "failed");
      await this.#deliver(delivery.eventId);
      return;
    }
    if (text.trim().toLowerCase() === "stop" || text.trim() === "/codex stop") {
      const active = this.#active.get(delivery.conversationKey);
      const commandTime = slackTimestamp(delivery.messageTs);
      const startTime =
        active === undefined ? undefined : slackTimestamp(active.delivery.messageTs);
      if (
        active !== undefined &&
        (commandTime === undefined || startTime === undefined || commandTime < startTime)
      ) {
        this.#store.complete(
          delivery.eventId,
          `That stop request predates the active ${this.#agentName} turn.`,
          "failed",
        );
        await this.#deliver(delivery.eventId);
        return;
      }
      const acknowledgement = await this.#stop({
        ...(active === undefined ? {} : { eventId: active.delivery.eventId }),
        identity: input.identity,
        replyContext: { channelId: binding.channelId, threadTs: binding.threadTs },
        responder: input.responder,
      });
      this.#store.complete(delivery.eventId, acknowledgement, "failed");
      await this.#deliver(delivery.eventId);
      return;
    }
    if (text.trim() === "/codex status") {
      const conversation = this.#store.getConversation(delivery.conversationKey);
      let status = `No ${this.#agentName} session has started in this Slack thread.`;
      if (conversation?.threadId !== undefined) {
        status = `${this.#agentName} is ${conversation.state}.`;
      }
      this.#store.complete(delivery.eventId, status, "failed");
      await this.#deliver(delivery.eventId);
      return;
    }
    const answer = this.#input.answerPending(binding);
    if (answer === "invalid") {
      this.#store.complete(
        delivery.eventId,
        `That answer was not sent to ${this.#agentName}. Keep secret values local.`,
        "failed",
      );
      await this.#deliver(delivery.eventId);
      return;
    }
    if (answer === "accepted") {
      if (!this.#linkAnswer(delivery)) {
        this.#store.complete(
          delivery.eventId,
          `The question is no longer attached to an active ${this.#agentName} turn.`,
          "failed",
        );
        await this.#deliver(delivery.eventId);
      }
      return;
    }
    const previous = this.#admissions.get(delivery.conversationKey) ?? Promise.resolve();
    let completion: Promise<void> | undefined;
    const admission = previous
      .catch(() => undefined)
      .then(async () => {
        const active = this.#active.get(delivery.conversationKey);
        if (
          active !== undefined &&
          !active.terminal &&
          !active.stopRequested &&
          input.imagePaths === undefined
        ) {
          if (active.turnId === undefined)
            throw new Error(`${this.#agentName} has not confirmed its active turn`);
          const turnId = active.turnId;
          const steering = Promise.resolve().then(() =>
            this.#admitSteer(active, delivery, turnId, text),
          );
          active.pendingSteers.add(steering);
          let refusal: unknown;
          try {
            await steering;
          } catch (error) {
            refusal = error;
          } finally {
            active.pendingSteers.delete(steering);
          }
          if (refusal !== undefined) {
            if (
              !(refusal instanceof ConversationSteerUnavailableError) &&
              !isUnadmittedNativeSteer(refusal)
            )
              throw refusal;
            if (active.stopRequested) {
              this.#cancelUnadmitted(delivery);
              completion = active.done;
              return;
            }
            this.#store.markUnadmitted(delivery.eventId, turnId);
            await active.done;
            this.#assertReady();
            if (active.stopRequested) {
              this.#cancelUnadmitted(delivery);
              return;
            }
            this.#store.retryUnadmitted(delivery.eventId, turnId);
            const started = await this.#start(delivery, input);
            completion = started.done;
            return;
          }
          completion = active.done;
          return;
        }
        if (active !== undefined) await active.done;
        const started = await this.#start(delivery, input);
        completion = started.done;
      });
    this.#admissions.set(delivery.conversationKey, admission);
    try {
      await admission;
      await completion;
    } catch (error) {
      this.#assertOwned();
      const current = this.#store.getDelivery(delivery.eventId);
      if (current?.completionStatus === undefined) {
        let status: NativeCompletionStatus = "failed";
        if (current?.state === "dispatching" || current?.state === "running") status = "uncertain";
        this.#store.complete(
          delivery.eventId,
          error instanceof Error
            ? error.message
            : `${this.#agentName} could not start this request.`,
          status,
        );
      }
      await this.#deliver(delivery.eventId);
    } finally {
      if (this.#admissions.get(delivery.conversationKey) === admission)
        this.#admissions.delete(delivery.conversationKey);
    }
  }

  async #admitSteer(
    active: ActiveTurn,
    delivery: NativeDelivery,
    turnId: string,
    text: string,
  ): Promise<void> {
    this.#assertReady();
    this.#store.steering(delivery.eventId, turnId);
    this.#assertReady();
    try {
      await this.#native.steer(active.threadId, turnId, text, delivery.eventId);
    } catch (refusal) {
      if (refusal instanceof ConversationSteerUnavailableError || isUnadmittedNativeSteer(refusal))
        throw refusal;
      let accepted = false;
      try {
        const turn = await this.#native.readTurn(active.threadId, turnId);
        this.#assertReady();
        accepted =
          Array.isArray(turn?.items) &&
          turn.items.some(
            (item: unknown) =>
              isRecord(item) && item.type === "userMessage" && item.clientId === delivery.eventId,
          );
      } catch (error) {
        this.#logger.warn({ error }, "Native steering admission remains uncertain");
      }
      if (!accepted) throw refusal;
      this.#assertReady();
    }
    this.#assertOwned();
    if (!active.terminal) this.#store.steered(delivery.eventId, turnId);
    this.#store.linkFollowup(delivery.eventId, active.delivery.eventId);
    this.#input.invalidateAnswers(active.threadId);
    this.#publishActivity(active.delivery);
  }

  async handleApproval(input: HandleApprovalInput): Promise<void> {
    this.#assertOwned();
    const accepted = this.#input.approve({
      approvalId: input.approvalId,
      approved: input.approved,
      teamId: input.identity.teamId,
      userId: input.identity.userId,
      channelId: input.identity.channelId,
      threadTs: input.replyContext.threadTs,
    });
    if (!accepted)
      await input.responder.postPrivateInfo(
        input.replyContext,
        input.identity.userId,
        `This ${this.#agentName} request is no longer pending.`,
      );
  }

  isExecuting(key: string, turnId: string): boolean {
    const active = this.#active.get(key);
    return (
      !this.#stopping &&
      active !== undefined &&
      !active.terminal &&
      active.turnId === turnId &&
      !this.#waitingThreads.has(active.threadId) &&
      !this.#uncertainThreads.has(active.threadId) &&
      this.#input.pendingCount(active.delivery) === 0
    );
  }

  async handleStopRun(input: HandleConversationActionInput): Promise<void> {
    const acknowledgement = await this.#stop(input);
    await input.responder.postInfo(input.replyContext, acknowledgement);
  }

  async #stop(input: HandleConversationActionInput): Promise<string> {
    this.#assertOwned();
    const active = this.#active.get(conversationKey(input));
    if (active === undefined || active.terminal)
      return `No active ${this.#agentName} turn in this Slack thread.`;
    if (input.eventId !== undefined && input.eventId !== active.delivery.eventId)
      return `That ${this.#agentName} turn is no longer active.`;
    active.stopRequested = true;
    for (const retained of this.#store.listUnadmitted()) {
      if (
        retained.conversationKey === active.delivery.conversationKey &&
        retained.unadmittedTurnId === active.turnId
      )
        this.#cancelUnadmitted(retained);
    }
    this.#assertOwned();
    this.#interruptRequested(active);
    this.#input.invalidateThread(active.threadId);
    return `Stop requested. ${this.#agentName} will confirm when its turn has stopped.`;
  }

  #interruptRequested(active: ActiveTurn): void {
    if (
      !active.stopRequested ||
      active.turnId === undefined ||
      active.terminal ||
      active.interrupting !== undefined ||
      this.#active.get(active.delivery.conversationKey) !== active
    )
      return;
    const turnId = active.turnId;
    active.interrupting = Promise.resolve()
      .then(async () => {
        this.#assertReady();
        if (
          active.terminal ||
          active.turnId !== turnId ||
          this.#active.get(active.delivery.conversationKey) !== active
        )
          return;
        await this.#native.interrupt(active.threadId, turnId);
      })
      .catch((error: unknown) => {
        this.#logger.warn({ error }, "Native cancellation is not confirmed");
        if (!active.terminal && this.#active.get(active.delivery.conversationKey) === active) {
          this.#uncertainThreads.add(active.threadId);
          this.#publishActivity(active.delivery);
        }
      });
  }

  #cancelUnadmitted(delivery: NativeDelivery): void {
    if (this.#store.getDelivery(delivery.eventId)?.completionStatus === undefined)
      this.#store.complete(
        delivery.eventId,
        "This instruction was canceled before native admission.",
        "failed",
      );
    void this.#deliver(delivery.eventId).catch((error: unknown) =>
      this.#logger.warn({ error }, "Canceled native instruction delivery will retry"),
    );
  }

  async handleNewSession(input: HandleConversationActionInput): Promise<void> {
    await input.responder.postInfo(
      input.replyContext,
      `Start a new Slack thread for a new ${this.#agentName} conversation.`,
    );
  }

  async shutdown(): Promise<void> {
    this.#stopping = true;
    if (this.#deliveryTimer !== undefined) clearInterval(this.#deliveryTimer);
    this.#input.close();
    try {
      await settleBefore(
        Promise.allSettled(
          [...this.#active.values()].map(async (active) => {
            if (active.turnId !== undefined)
              await this.#native.interrupt(active.threadId, active.turnId);
          }),
        ),
        2_000,
      );
    } finally {
      try {
        await this.#native.close();
      } finally {
        await Promise.allSettled(
          [...this.#active.values()].map((active) =>
            this.#complete(
              active,
              "uncertain",
              `The Slack bridge stopped before ${this.#agentName} confirmed completion. This turn has not been replayed.`,
            ),
          ),
        );
        await Promise.allSettled(this.#admissions.values());
        await settleBefore(Promise.allSettled(this.#delivering.values()), 2_000);
      }
    }
  }

  async #start(
    delivery: NativeDelivery,
    input: Pick<HandleMentionInput, "imagePaths" | "slackContext">,
  ): Promise<ActiveTurn> {
    this.#assertReady();
    let conversation = this.#store.getConversation(delivery.conversationKey);
    if (conversation?.state === "uncertain") {
      if (conversation.threadId === undefined || conversation.activeTurnId === undefined)
        throw new Error(
          "The previous dispatch could not be identified. Start a new Slack thread while its session is inspected.",
        );
      this.#assertReady();
      const terminal = await this.#native.readTurn(
        conversation.threadId,
        conversation.activeTurnId,
      );
      this.#assertReady();
      if (
        !isRecord(terminal) ||
        !["completed", "failed", "interrupted"].includes(String(terminal.status))
      )
        throw new Error(
          `The previous ${this.#agentName} turn is still unconfirmed. Open its ${this.#agentName} session before continuing.`,
        );
      if (
        !this.#store.reconcileTerminal(
          delivery.conversationKey,
          conversation.threadId,
          conversation.activeTurnId,
        )
      )
        throw new Error(`The previous ${this.#agentName} turn changed during reconciliation.`);
      conversation = this.#store.getConversation(delivery.conversationKey);
    }
    let threadId = conversation?.threadId;
    const isNew = threadId === undefined;
    if (threadId === undefined) {
      this.#assertReady();
      threadId = await this.#native.startThread(this.#cwd);
      this.#assertReady();
      this.#store.bind(delivery.conversationKey, threadId, this.#cwd);
    } else {
      this.#assertReady();
      await this.#native.resumeThread(threadId, conversation?.cwd ?? this.#cwd);
      this.#assertReady();
    }
    let resolve = () => {};
    const done = new Promise<void>((completed) => {
      resolve = completed;
    });
    const active: ActiveTurn = {
      delivery,
      threadId,
      done,
      resolve,
      items: new Map(),
      messages: new Map(),
      finalMessages: new Map(),
      pendingSteers: new Set(),
      terminal: false,
      stopRequested: false,
    };
    this.#active.set(delivery.conversationKey, active);
    let prompt = delivery.text;
    if (isNew && input.slackContext !== undefined)
      prompt = composeSlackRequest(delivery.text, input.slackContext);
    let dispatchRequested = false;
    try {
      this.#assertReady();
      await this.#native.validateTurn?.(prompt, input.imagePaths);
      this.#assertReady();
      this.#store.dispatch(delivery.eventId);
      this.#publishActivity(delivery);
      this.#assertReady();
      dispatchRequested = true;
      const turnId = await this.#native.startTurn(
        threadId,
        prompt,
        input.imagePaths,
        delivery.eventId,
      );
      if (active.turnId !== undefined && active.turnId !== turnId)
        throw new Error(`${this.#agentName} confirmed a different active turn`);
      this.#assertOwned();
      active.turnId = turnId;
      if (!active.terminal) this.#store.started(delivery.eventId, turnId);
      this.#interruptRequested(active);
      this.#publishActivity(delivery);
      this.#logger.info(
        { eventId: delivery.eventId, threadId, turnId },
        `Native ${this.#agentName} turn started`,
      );
    } catch (error) {
      let status: NativeCompletionStatus = "failed";
      if (dispatchRequested && !(error instanceof ConversationDispatchRejectedError))
        status = "uncertain";
      await this.#complete(
        active,
        status,
        error instanceof Error ? error.message : `${this.#agentName} dispatch was not confirmed.`,
      );
    }
    return active;
  }

  #observe(message: Record<string, unknown>): void {
    if (!isRecord(message.params)) return;
    const params = message.params;
    if (
      message.method === "thread/status/changed" &&
      typeof params.threadId === "string" &&
      isRecord(params.status)
    ) {
      const threadId = params.threadId;
      const status = params.status;
      if (
        status.type === "active" &&
        Array.isArray(status.activeFlags) &&
        status.activeFlags.length > 0
      )
        this.#waitingThreads.add(threadId);
      else this.#waitingThreads.delete(threadId);
      if (status.type === "systemError" || status.type === "notLoaded")
        this.#uncertainThreads.add(threadId);
      else this.#uncertainThreads.delete(threadId);
      const conversation = this.#store
        .listConversations()
        .find((entry) => entry.threadId === threadId);
      if (conversation !== undefined) {
        const delivery = this.#store.lastForConversation(conversation.key);
        if (delivery !== undefined) this.#publishActivity(delivery);
      }
      return;
    }
    const active = [...this.#active.values()].find((turn) => turn.threadId === params.threadId);
    if (active === undefined || active.terminal) return;
    if (message.method === "serverRequest/resolved") {
      if (typeof params.requestId === "string" || typeof params.requestId === "number")
        this.#input.resolved(active.threadId, params.requestId);
      return;
    }
    if (
      message.method === "turn/started" &&
      isRecord(params.turn) &&
      typeof params.turn.id === "string"
    ) {
      if (active.turnId !== undefined && active.turnId !== params.turn.id) return;
      this.#bindTurn(active, params.turn.id);
      return;
    }
    if (
      params.turnId !== undefined &&
      active.turnId !== undefined &&
      params.turnId !== active.turnId
    )
      return;
    if (message.method === "turn/uncertain") {
      let text = `${this.#agentName} stopped without confirmed completion. This request has not been replayed.`;
      if (isRecord(params.error) && typeof params.error.message === "string")
        text = params.error.message;
      void this.#complete(active, "uncertain", text).catch((error: unknown) => {
        this.#logger.error({ error }, "Uncertain native completion could not be persisted");
      });
      return;
    }
    if (
      (message.method === "item/started" || message.method === "item/completed") &&
      isRecord(params.item)
    ) {
      const item = params.item;
      if (this.#input.pendingCount(active.delivery) === 0)
        this.#waitingThreads.delete(active.threadId);
      if (typeof item.id === "string") {
        active.items.set(item.id, item);
        if (item.type === "agentMessage" && typeof item.text === "string") {
          active.messages.set(item.id, item.text);
          if (item.phase === "final_answer") active.finalMessages.set(item.id, item.text);
        }
      }
    }
    if (
      message.method === "item/agentMessage/delta" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      const text = `${active.messages.get(params.itemId) ?? ""}${params.delta}`;
      active.messages.set(params.itemId, text);
      const item = active.items.get(params.itemId);
      if (item?.phase === "final_answer") active.finalMessages.set(params.itemId, text);
    }
    if (
      message.method === "item/started" ||
      message.method === "item/completed" ||
      message.method === "item/agentMessage/delta"
    )
      this.#publishActivity(active.delivery);
    if (message.method === "turn/completed" && isRecord(params.turn)) {
      if (active.turnId !== undefined && params.turn.id !== active.turnId) return;
      const turn = params.turn;
      if (typeof turn.id !== "string") return;
      this.#bindTurn(active, turn.id);
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) {
          if (
            isRecord(item) &&
            item.type === "agentMessage" &&
            typeof item.id === "string" &&
            typeof item.text === "string"
          ) {
            active.items.set(item.id, item);
            active.messages.set(item.id, item.text);
            if (item.phase === "final_answer") active.finalMessages.set(item.id, item.text);
          }
        }
      }
      const finals = [...active.finalMessages.values()];
      let text = finals.join("\n\n");
      let status: NativeCompletionStatus = "completed";
      if (turn.status !== "completed") {
        status = "failed";
        text = `${this.#agentName} stopped before completing this request.`;
        if (isRecord(turn.error) && typeof turn.error.message === "string")
          text = turn.error.message;
      } else if (text.trim().length === 0) {
        const unphased = [...active.messages.entries()].filter(([id]) => {
          const item = active.items.get(id);
          return item?.type === "agentMessage" && item.phase == null;
        });
        text = unphased.at(-1)?.[1] ?? `${this.#agentName} completed without a final response.`;
      }
      void this.#complete(active, status, text).catch((error: unknown) => {
        this.#logger.error({ error }, "Native completion could not be persisted");
      });
    }
  }

  async #request(request: AppServerRequest): Promise<unknown> {
    this.#assertOwned();
    if (!isRecord(request.params))
      throw new Error(`${this.#agentName} supplied an invalid interaction request`);
    const params = request.params;
    const active = [...this.#active.values()].find(
      (turn) => turn.threadId === params.threadId && !turn.terminal,
    );
    if (active === undefined)
      throw new Error(`This ${this.#agentName} request has no active Slack conversation`);
    if (typeof params.turnId === "string" && active.turnId === undefined)
      this.#bindTurn(active, params.turnId);
    if (params.turnId !== undefined && params.turnId !== null && params.turnId !== active.turnId)
      throw new Error(`This ${this.#agentName} interaction belongs to a different turn`);
    if (active.stopRequested)
      throw new Error(`Cancellation was requested for this ${this.#agentName} turn`);
    let forwarded = request;
    if (request.method === "item/fileChange/requestApproval" && typeof params.itemId === "string") {
      const item = active.items.get(params.itemId);
      if (item?.type === "fileChange")
        forwarded = { ...request, params: { ...params, changes: item.changes } };
    }
    const response = await this.#input.request(forwarded, {
      eventId: active.delivery.eventId,
      threadId: active.threadId,
      ...(active.turnId === undefined ? {} : { turnId: active.turnId }),
      teamId: active.delivery.teamId,
      userId: active.delivery.userId,
      channelId: active.delivery.channelId,
      threadTs: active.delivery.threadTs,
    });
    this.#assertReady();
    if (active.terminal || this.#active.get(active.delivery.conversationKey) !== active)
      throw new Error(`This ${this.#agentName} interaction is no longer active`);
    return response;
  }

  #bindTurn(active: ActiveTurn, turnId: string): void {
    if (active.turnId !== undefined && active.turnId !== turnId)
      throw new Error("The native event belongs to a different turn");
    const current = this.#store.getDelivery(active.delivery.eventId);
    if (current?.state === "dispatching") this.#store.started(active.delivery.eventId, turnId);
    else if (current?.nativeTurnId !== turnId)
      throw new Error("The native event does not match its persisted turn");
    active.turnId = turnId;
    this.#interruptRequested(active);
  }

  #assertReady(): void {
    this.#assertOwned();
    if (this.#stopping) throw new Error(`${this.#agentName} is restarting.`);
  }

  #linkAnswer(delivery: NativeDelivery): boolean {
    const active = this.#active.get(delivery.conversationKey);
    if (active === undefined || active.terminal || active.turnId === undefined) return false;
    this.#store.steering(delivery.eventId, active.turnId);
    this.#store.steered(delivery.eventId, active.turnId);
    this.#store.linkFollowup(delivery.eventId, active.delivery.eventId);
    this.#publishActivity(active.delivery);
    return true;
  }

  #publishActivity(delivery: NativeDelivery): void {
    try {
      this.#assertOwned();
      const conversation = this.#store.getConversation(delivery.conversationKey);
      if (conversation === undefined) return;
      const latest = this.#store.lastForConversation(delivery.conversationKey);
      const pendingInputCount = this.#input.pendingCount(delivery);
      let phase: NativeActivitySnapshot["phase"] = "idle";
      if (
        conversation.state === "uncertain" ||
        (conversation.threadId !== undefined && this.#uncertainThreads.has(conversation.threadId))
      )
        phase = "uncertain";
      else if (
        pendingInputCount > 0 ||
        (conversation.threadId !== undefined && this.#waitingThreads.has(conversation.threadId))
      )
        phase = "waiting";
      else if (conversation.state === "running") phase = "executing";
      else if (
        this.#store
          .listUnadmitted()
          .some((entry) => entry.conversationKey === delivery.conversationKey)
      )
        phase = "waiting";
      this.#activityRevision += 1;
      this.#onActivity?.({
        conversationKey: delivery.conversationKey,
        teamId: delivery.teamId,
        userId: delivery.userId,
        channelId: delivery.channelId,
        threadTs: delivery.threadTs,
        ...(conversation.threadId === undefined ? {} : { nativeThreadId: conversation.threadId }),
        ...(conversation.activeTurnId === undefined
          ? {}
          : { nativeTurnId: conversation.activeTurnId }),
        revision: this.#activityRevision,
        phase,
        pendingInputCount,
        needsReconciliation:
          (latest?.rootEventId === undefined && latest?.completionStatus === "uncertain") ||
          this.#store
            .pendingDeliveries()
            .some(
              (entry) =>
                entry.conversationKey === delivery.conversationKey &&
                this.#store
                  .getFinalParts(entry.eventId)
                  .some((part) => part.state === "uncertain" || part.state === "sending"),
            ),
        finalPendingDelivery: this.#store
          .pendingDeliveries()
          .some((entry) => entry.conversationKey === delivery.conversationKey),
      });
    } catch (error) {
      this.#logger.warn({ error }, "Native activity publication failed");
    }
  }

  #complete(active: ActiveTurn, status: NativeCompletionStatus, text: string): Promise<void> {
    if (active.completion !== undefined) return active.completion;
    active.terminal = true;
    this.#input.invalidateThread(active.threadId);
    try {
      this.#assertOwned();
      this.#store.complete(active.delivery.eventId, text, status);
      this.#waitingThreads.delete(active.threadId);
      this.#publishActivity(active.delivery);
    } catch (error) {
      if (this.#active.get(active.delivery.conversationKey) === active)
        this.#active.delete(active.delivery.conversationKey);
      active.resolve();
      return Promise.reject(error);
    }
    active.completion = this.#finishCompletion(active);
    return active.completion;
  }

  async #finishCompletion(active: ActiveTurn): Promise<void> {
    try {
      await Promise.allSettled(active.pendingSteers);
      void this.#deliver(active.delivery.eventId).catch((error: unknown) =>
        this.#logger.warn({ error }, "Native final delivery will retry"),
      );
    } finally {
      if (this.#active.get(active.delivery.conversationKey) === active)
        this.#active.delete(active.delivery.conversationKey);
      active.resolve();
      void this.#resumeRetained(active.delivery.conversationKey).catch((error: unknown) =>
        this.#logger.warn({ error }, "A retained native instruction remains pending"),
      );
    }
  }

  async #resumeRetained(key: string): Promise<void> {
    if (this.#stopping) return;
    this.#assertReady();
    if (!this.#store.listUnadmitted().some((delivery) => delivery.conversationKey === key)) return;
    const previous = this.#admissions.get(key) ?? Promise.resolve();
    const admission = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.#stopping) return;
        this.#assertReady();
        if (this.#active.has(key) || this.#store.getConversation(key)?.state !== "idle") return;
        const retained = this.#store
          .listUnadmitted()
          .find((delivery) => delivery.conversationKey === key);
        if (retained?.unadmittedTurnId === undefined) return;
        this.#store.retryUnadmitted(retained.eventId, retained.unadmittedTurnId);
        await this.#start(retained, {});
      });
    this.#admissions.set(key, admission);
    try {
      await admission;
    } finally {
      if (this.#admissions.get(key) === admission) this.#admissions.delete(key);
    }
  }

  #flush(): void {
    if (this.#stopping) return;
    for (const delivery of this.#store.pendingDeliveries())
      void this.#deliver(delivery.eventId).catch((error: unknown) =>
        this.#logger.warn({ error }, "Native final delivery will retry"),
      );
  }

  #deliver(eventId: string): Promise<void> {
    const existing = this.#delivering.get(eventId);
    if (existing !== undefined) return existing;
    const delivery = this.#deliverOnce(eventId).finally(() => this.#delivering.delete(eventId));
    this.#delivering.set(eventId, delivery);
    return delivery;
  }

  async #deliverOnce(eventId: string): Promise<void> {
    if (this.#stopping) return;
    const active = [...this.#active.values()].find((turn) => turn.delivery.eventId === eventId);
    if (active !== undefined) await Promise.allSettled(active.pendingSteers);
    if (this.#stopping) return;
    this.#assertOwned();
    try {
      await this.#finalDelivery.deliver(eventId);
    } finally {
      if (!this.#stopping) {
        const delivery = this.#store.getDelivery(eventId);
        if (delivery !== undefined) this.#publishActivity(delivery);
      }
    }
  }
}
