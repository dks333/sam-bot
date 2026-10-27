import type { Logger } from "pino";

import type { SlackMessageStatus, SlackResponder } from "../slack/responder.js";
import { redactSensitiveText } from "../slack/redact-sensitive.js";

import {
  NativeConversationStore,
  type NativeDelivery,
  type NativeFinalIdentity,
  type NativeFinalPart,
  type NativeFinalReconciliation,
} from "../persistence/native-conversation-store.js";

export interface NativeFinalDeliveryTransport {
  setMessageStatus: SlackResponder["setMessageStatus"];
  postFinal(delivery: NativeDelivery, text: string, identity: NativeFinalIdentity): Promise<string>;
  update(delivery: NativeDelivery, receipt: string, text: string): Promise<void>;
  reconcile(
    delivery: NativeDelivery,
    identity: NativeFinalIdentity,
  ): Promise<NativeFinalReconciliation>;
}

export class NativeFinalNotSentError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 5_000) {
    super(message);
    this.name = "NativeFinalNotSentError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function splitNativeResponse(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 30_000) {
    const candidate = remaining.slice(0, 30_000);
    const paragraph = candidate.lastIndexOf("\n\n");
    let boundary = 30_000;
    if (paragraph > 15_000) boundary = paragraph + 2;
    const last = remaining.charCodeAt(boundary - 1);
    if (last >= 0xd800 && last <= 0xdbff) boundary -= 1;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining.length > 0) parts.push(remaining);
  if (parts.length === 0) parts.push("Codex completed without a final response.");
  return parts;
}

function identity(part: NativeFinalPart): NativeFinalIdentity {
  if (part.attemptedAt === undefined)
    throw new Error("The native final delivery has no recorded send attempt");
  return {
    id: part.id,
    part: part.index,
    contentHash: part.contentHash,
    attemptedAt: part.attemptedAt,
  };
}

export class NativeFinalDelivery {
  readonly #store: NativeConversationStore;
  readonly #transport: NativeFinalDeliveryTransport;
  readonly #logger: Pick<Logger, "info" | "warn">;
  readonly #assertOwned: () => void;
  readonly #redact: (text: string) => string;
  readonly #inflight = new Map<string, Promise<void>>();

  constructor(options: {
    store: NativeConversationStore;
    transport: NativeFinalDeliveryTransport;
    logger: Pick<Logger, "info" | "warn">;
    assertOwned: () => void;
    redactSensitiveText?: (text: string) => string;
  }) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#logger = options.logger;
    this.#assertOwned = options.assertOwned;
    this.#redact = options.redactSensitiveText ?? redactSensitiveText;
  }

  deliver(eventId: string): Promise<void> {
    const existing = this.#inflight.get(eventId);
    if (existing !== undefined) return existing;
    const pending = this.#deliver(eventId).finally(() => this.#inflight.delete(eventId));
    this.#inflight.set(eventId, pending);
    return pending;
  }

  async #deliver(eventId: string): Promise<void> {
    this.#assertOwned();
    const delivery = this.#store.getDelivery(eventId);
    if (
      delivery?.finalText === undefined ||
      delivery.revokedAt !== undefined ||
      delivery.deliveryMessageTs !== undefined ||
      delivery.rootEventId !== undefined
    )
      return;
    const parts = this.#store.prepareFinalParts(
      eventId,
      splitNativeResponse(this.#redact(delivery.finalText)),
      this.#redact,
    );
    for (const initial of parts) {
      this.#assertOwned();
      if (initial.state === "confirmed") continue;
      if (initial.retryAfterAt !== undefined && Date.parse(initial.retryAfterAt) > Date.now())
        return;
      let part = initial;
      if (part.messageTs !== undefined) {
        const knownReceipt = part.messageTs;
        if (part.state === "pending") part = this.#store.beginFinalPart(eventId, part.index);
        try {
          await this.#transport.update(delivery, knownReceipt, part.text);
        } catch (error) {
          this.#assertOwned();
          if (error instanceof NativeFinalNotSentError)
            this.#store.retryFinalPart(eventId, part.index, error.retryAfterMs);
          else this.#store.uncertainFinalPart(eventId, part.index);
          this.#logger.warn(
            { error, eventId, part: part.index },
            "Known native final update will retry",
          );
          return;
        }
        this.#assertOwned();
        this.#store.confirmFinalPart(eventId, part.index, knownReceipt);
        continue;
      }
      if (part.state === "sending" || part.state === "uncertain") {
        this.#store.uncertainFinalPart(eventId, part.index);
        let proof: NativeFinalReconciliation;
        try {
          proof = await this.#transport.reconcile(delivery, identity(part));
        } catch (error) {
          this.#assertOwned();
          this.#logger.warn(
            { error, eventId, part: part.index },
            "Native final reconciliation is unavailable",
          );
          return;
        }
        this.#assertOwned();
        if (proof.status === "found") {
          this.#store.confirmFinalPart(eventId, part.index, proof.messageTs);
          continue;
        }
        if (proof.status === "absent") {
          this.#store.retryFinalPart(eventId, part.index);
          return;
        }
        this.#logger.warn(
          { eventId, part: part.index, reason: proof.reason },
          "Native final delivery needs reconciliation",
        );
        return;
      }
      part = this.#store.beginFinalPart(eventId, part.index);
      let receipt: string;
      try {
        receipt = await this.#transport.postFinal(delivery, part.text, identity(part));
      } catch (error) {
        this.#assertOwned();
        if (error instanceof NativeFinalNotSentError)
          this.#store.retryFinalPart(eventId, part.index, error.retryAfterMs);
        else this.#store.uncertainFinalPart(eventId, part.index);
        this.#logger.warn(
          { error, eventId, part: part.index },
          "Native final delivery remains pending",
        );
        return;
      }
      this.#assertOwned();
      this.#store.confirmFinalPart(eventId, part.index, receipt);
    }
    this.#assertOwned();
    const confirmed = this.#store.getFinalParts(eventId);
    const receipt = confirmed.at(-1)?.messageTs;
    if (receipt === undefined || confirmed.some((part) => part.state !== "confirmed"))
      throw new Error("The native final delivery does not have every confirmed receipt");
    let status: SlackMessageStatus = "failed";
    if (delivery.completionStatus === "completed") status = "completed";
    else if (delivery.completionStatus === "uncertain") status = "waiting";
    const followers = this.#store
      .listDeliveriesForConversation(delivery.conversationKey)
      .filter((entry) => entry.rootEventId === eventId && entry.revokedAt === undefined);
    for (const target of [delivery, ...followers]) {
      this.#assertOwned();
      try {
        await this.#transport.setMessageStatus(
          { channelId: target.channelId, messageTs: target.messageTs },
          status,
          "working",
        );
      } catch (error) {
        this.#assertOwned();
        this.#logger.warn(
          { error, eventId, messageTs: target.messageTs },
          "Native final reaction will retry",
        );
        return;
      }
    }
    this.#assertOwned();
    this.#store.delivered(eventId, receipt);
    this.#logger.info({ eventId, messageTs: receipt }, "Native final delivered");
  }
}
