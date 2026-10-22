import { describe, expect, it, vi } from "vitest";

import {
  AgentSessionStatusAdapter,
  type AgentSessionStatus,
  type AgentSessionStatusClient,
} from "../src/slack/agent-session-status.js";

const target = { teamId: "T_SYNTHETIC", channelId: "C_SYNTHETIC", threadTs: "123.456" };

function fixture() {
  const apiCall = vi.fn<AgentSessionStatusClient["apiCall"]>();
  apiCall.mockResolvedValue({ ok: true });
  return { apiCall, adapter: new AgentSessionStatusAdapter({ apiCall }) };
}

describe("Slack agent session status adapter", () => {
  const statuses: AgentSessionStatus[] = ["processing", "suspended", "active", "closed"];
  it.each(statuses)(
    "writes the exact thread status %s through the installed generic API",
    async (status) => {
      const value = fixture();
      await expect(value.adapter.setStatus(target, status)).resolves.toEqual({ kind: "applied" });
      expect(value.apiCall).toHaveBeenCalledExactlyOnceWith("agents.sessions.setStatus", {
        channel_id: target.channelId,
        thread_ts: target.threadTs,
        status,
      });
    },
  );

  it("accepts the non-interactive warning and another agent's aggregate session status", async () => {
    const value = fixture();
    value.apiCall.mockResolvedValue({
      ok: true,
      status: "suspended",
      agent_status: "processing",
      warning: "missing_agent_session_stopped_event_subscription",
    });
    await expect(value.adapter.setStatus(target, "processing")).resolves.toEqual({
      kind: "applied",
    });
  });

  it("returns the server's rate-limit delay without sleeping or retrying", async () => {
    const value = fixture();
    value.apiCall.mockRejectedValue({
      code: "slack_webapi_rate_limited_error",
      retryAfter: 42,
    });
    await expect(value.adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "rate-limited",
      retryAfterMs: 42_000,
    });
    expect(value.apiCall).toHaveBeenCalledTimes(1);
  });

  it.each(["missing_scope", "feature_disabled", "unknown_method", "token_revoked"])(
    "reports the unavailable workspace capability %s",
    async (error) => {
      const value = fixture();
      value.apiCall.mockRejectedValue({
        code: "slack_webapi_platform_error",
        data: { ok: false, error },
      });
      await expect(value.adapter.setStatus(target, "processing")).resolves.toEqual({
        kind: "unavailable",
        scope: "team",
        reason: error,
      });
    },
  );

  it("limits channel membership failures to their own thread", async () => {
    const value = fixture();
    value.apiCall.mockResolvedValue({ ok: false, error: "channel_not_found" });
    await expect(value.adapter.setStatus(target, "processing")).resolves.toEqual({
      kind: "unavailable",
      scope: "thread",
      reason: "channel_not_found",
    });
  });

  it("keeps transient and malformed failures best effort without exposing exception text", async () => {
    const value = fixture();
    value.apiCall.mockRejectedValueOnce(new Error("synthetic private diagnostic"));
    value.apiCall.mockResolvedValueOnce({ ok: false, error: "internal_error" });
    value.apiCall.mockRejectedValueOnce({
      code: "slack_webapi_rate_limited_error",
      retryAfter: Infinity,
    });
    await expect(value.adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "retry",
      reason: "request_failed",
    });
    await expect(value.adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "retry",
      reason: "internal_error",
    });
    await expect(value.adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "retry",
      reason: "request_failed",
    });
  });

  it("does not claim confirmation for malformed or mismatched responses", async () => {
    const value = fixture();
    value.apiCall.mockResolvedValueOnce(null);
    value.apiCall.mockResolvedValueOnce({ ok: true, agent_status: "processing" });
    await expect(value.adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "retry",
      reason: "invalid_response",
    });
    await expect(value.adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "retry",
      reason: "unexpected_agent_status",
    });
  });

  it("rechecks ownership immediately before every mutation and does not send when fenced", async () => {
    const value = fixture();
    const assertOwned = vi.fn(() => {
      throw new Error("Synthetic lost lease");
    });
    const adapter = new AgentSessionStatusAdapter({ apiCall: value.apiCall }, { assertOwned });
    await expect(adapter.setStatus(target, "active")).resolves.toEqual({
      kind: "unavailable",
      scope: "team",
      reason: "runtime_ownership_lost",
    });
    expect(assertOwned).toHaveBeenCalledTimes(1);
    expect(value.apiCall).not.toHaveBeenCalled();
  });
});
