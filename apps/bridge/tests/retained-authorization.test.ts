import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  isNativeDeliveryAuthorized,
  revokeUnauthorizedDeliveries,
} from "../src/bridge/retained-authorization.js";
import {
  NativeConversationStore,
  readNativeConversationSchemaVersion,
  type NativeClaim,
} from "../src/persistence/native-conversation-store.js";
import type { AuthorizationPolicy } from "../src/slack/authorize.js";

const policy: AuthorizationPolicy = {
  allowedTeamId: "synthetic-team",
  allowedUserId: "synthetic-owner",
  allowedChannelIds: new Set(["synthetic-channel"]),
};
const claim: NativeClaim = {
  eventId: "synthetic-event",
  teamId: policy.allowedTeamId,
  userId: policy.allowedUserId,
  channelId: "synthetic-channel",
  threadTs: "1.0",
  messageTs: "1.1",
  text: "Synthetic instruction",
};
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "synthetic-retained-access-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "native.sqlite");
  const store = new NativeConversationStore(file);
  cleanups.push(() => store.close());
  return { store, file };
}

describe("retained authorization", () => {
  it.each([
    { ...policy, allowedUserId: "synthetic-other-owner" },
    { ...policy, allowedTeamId: "synthetic-other-team" },
    { ...policy, allowedChannelIds: new Set(["synthetic-other-channel"]) },
    { ...policy, allowedEnterpriseId: "synthetic-enterprise" },
  ])("permanently revokes retained work after an access-policy change", (changed) => {
    const { store, file } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected synthetic claim");
    expect(isNativeDeliveryAuthorized(current, policy)).toBe(true);
    expect(revokeUnauthorizedDeliveries(store, changed)).toBe(1);
    expect(store.getDelivery(claim.eventId)).toMatchObject({
      completionStatus: "failed",
      revokedAt: expect.any(String),
    });
    expect(store.pendingDeliveries()).toEqual([]);
    expect(() => store.dispatch(claim.eventId)).toThrow("revoked");
    const reopened = new NativeConversationStore(file);
    cleanups.push(() => reopened.close());
    expect(revokeUnauthorizedDeliveries(reopened, policy)).toBe(0);
    const revoked = reopened.getDelivery(claim.eventId);
    if (revoked === undefined) throw new Error("Expected retained claim");
    expect(isNativeDeliveryAuthorized(revoked, policy)).toBe(false);
    const fresh = reopened.claim({ ...claim, eventId: "synthetic-new-event", messageTs: "1.2" });
    if (fresh === undefined) throw new Error("Expected fresh claim");
    expect(isNativeDeliveryAuthorized(fresh, policy)).toBe(true);
  });

  it("preserves unknown execution and prepared final evidence while suppressing output", () => {
    const { store } = setup();
    const current = store.claim(claim);
    if (current === undefined) throw new Error("Expected synthetic claim");
    store.bind(current.conversationKey, "synthetic-thread", "/synthetic/project");
    store.dispatch(claim.eventId);
    store.started(claim.eventId, "synthetic-turn");
    revokeUnauthorizedDeliveries(store, { ...policy, allowedUserId: "synthetic-other-owner" });
    expect(store.getDelivery(claim.eventId)).toMatchObject({
      completionStatus: "uncertain",
      nativeTurnId: "synthetic-turn",
      revokedAt: expect.any(String),
    });
    expect(store.getConversation(current.conversationKey)).toMatchObject({
      state: "uncertain",
      activeTurnId: "synthetic-turn",
    });

    const completed = store.claim({
      ...claim,
      eventId: "synthetic-final",
      messageTs: "2.1",
      threadTs: "2.0",
    });
    if (completed === undefined) throw new Error("Expected synthetic final");
    store.dispatch(completed.eventId);
    store.complete(completed.eventId, "Synthetic final", "completed");
    store.prepareFinalParts(completed.eventId, ["Synthetic final"]);
    store.beginFinalPart(completed.eventId, 0);
    const parts = store.getFinalParts(completed.eventId);
    revokeUnauthorizedDeliveries(store, { ...policy, allowedUserId: "synthetic-other-owner" });
    expect(store.getDelivery(completed.eventId)).toMatchObject({
      finalText: "Synthetic final",
      completionStatus: "completed",
      revokedAt: expect.any(String),
    });
    expect(store.getFinalParts(completed.eventId)).toEqual(parts);
    expect(store.pendingDeliveries()).toEqual([]);
    expect(() => store.prepareFinalParts(completed.eventId, ["Synthetic final"])).toThrow(
      "revoked",
    );
  });

  it("cancels a proven unadmitted follow-up without resuming it", () => {
    const { store } = setup();
    const current = store.claim(claim);
    const retained = store.claim({ ...claim, eventId: "synthetic-retained", messageTs: "1.2" });
    if (current === undefined || retained === undefined)
      throw new Error("Expected synthetic claims");
    store.bind(current.conversationKey, "synthetic-thread", "/synthetic/project");
    store.dispatch(current.eventId);
    store.started(current.eventId, "synthetic-turn");
    store.steering(retained.eventId, "synthetic-turn");
    store.markUnadmitted(retained.eventId, "synthetic-turn");
    store.complete(current.eventId, "Synthetic final", "completed");
    revokeUnauthorizedDeliveries(store, { ...policy, allowedUserId: "synthetic-other-owner" });
    expect(store.listUnadmitted()).toEqual([]);
    expect(store.getDelivery(retained.eventId)).toMatchObject({
      completionStatus: "failed",
      revokedAt: expect.any(String),
    });
    expect(() => store.retryUnadmitted(retained.eventId, "synthetic-turn")).toThrow("revoked");
  });

  it("retains direct-message and enterprise bindings without widening channel authorization", () => {
    const { store, file } = setup();
    const direct = store.claim({
      ...claim,
      channelId: "D_SYNTHETIC",
      enterpriseId: "synthetic-enterprise",
      directMessage: true,
    });
    const channel = store.claim({
      ...claim,
      eventId: "synthetic-channel-event",
      messageTs: "1.2",
      channelId: "C_SYNTHETIC",
      enterpriseId: "synthetic-enterprise",
      directMessage: false,
    });
    if (direct === undefined || channel === undefined) throw new Error("Expected synthetic claims");
    const enterprisePolicy = {
      ...policy,
      allowedEnterpriseId: "synthetic-enterprise",
      allowedChannelIds: new Set(["synthetic-other-channel"]),
    };
    const reopened = new NativeConversationStore(file);
    cleanups.push(() => reopened.close());
    expect(reopened.getDelivery(direct.eventId)).toMatchObject({
      directMessage: true,
      enterpriseId: "synthetic-enterprise",
    });
    expect(isNativeDeliveryAuthorized(direct, enterprisePolicy)).toBe(true);
    expect(isNativeDeliveryAuthorized(channel, enterprisePolicy)).toBe(false);
    expect(revokeUnauthorizedDeliveries(reopened, enterprisePolicy)).toBe(1);
  });

  it("migrates version-one records without losing final identities or execution evidence", () => {
    const { store, file } = setup();
    store.claim(claim);
    store.dispatch(claim.eventId);
    store.complete(claim.eventId, "Synthetic retained final", "completed");
    store.prepareFinalParts(claim.eventId, ["Synthetic retained final"]);
    const original = store.getDelivery(claim.eventId);
    const parts = store.getFinalParts(claim.eventId);
    const raw = new Database(file);
    raw.exec(
      "ALTER TABLE native_deliveries DROP COLUMN enterprise_id; ALTER TABLE native_deliveries DROP COLUMN direct_message; ALTER TABLE native_deliveries DROP COLUMN revoked_at",
    );
    raw.pragma("user_version = 1");
    raw.close();
    const migrated = new NativeConversationStore(file);
    cleanups.push(() => migrated.close());
    expect(readNativeConversationSchemaVersion(file)).toBe(2);
    expect(migrated.getDelivery(claim.eventId)).toEqual(original);
    expect(migrated.getFinalParts(claim.eventId)).toEqual(parts);
    expect(
      revokeUnauthorizedDeliveries(migrated, { ...policy, allowedUserId: "synthetic-other-owner" }),
    ).toBe(1);
    expect(migrated.pendingDeliveries()).toEqual([]);
  });
});
