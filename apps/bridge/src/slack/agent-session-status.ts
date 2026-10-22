export type AgentSessionStatus = "processing" | "suspended" | "active" | "closed";

export interface AgentSessionTarget {
  teamId: string;
  channelId: string;
  threadTs: string;
}

export interface AgentSessionStatusClient {
  apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;
}

export type AgentSessionStatusResult =
  | { kind: "applied" }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "unavailable"; scope: "team" | "thread"; reason: string }
  | { kind: "retry"; reason: string };

export interface AgentSessionStatusWriter {
  setStatus(
    target: AgentSessionTarget,
    status: AgentSessionStatus,
  ): Promise<AgentSessionStatusResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(reason: unknown): AgentSessionStatusResult {
  if (typeof reason !== "string" || !/^[a-z_]{1,80}$/u.test(reason))
    return { kind: "retry", reason: "request_failed" };
  if (
    [
      "feature_disabled",
      "missing_scope",
      "not_allowed_token_type",
      "unknown_method",
      "method_not_supported",
      "invalid_auth",
      "token_revoked",
      "token_expired",
      "not_authed",
      "account_inactive",
      "enterprise_is_restricted",
    ].includes(reason)
  )
    return { kind: "unavailable", scope: "team", reason };
  if (
    [
      "channel_not_found",
      "not_in_channel",
      "not_authorized",
      "no_permission",
      "access_denied",
      "invalid_arguments",
      "invalid_status",
      "thread_ts_required",
      "thread_ts_not_allowed",
    ].includes(reason)
  )
    return { kind: "unavailable", scope: "thread", reason };
  return { kind: "retry", reason };
}

function rejected(error: unknown): AgentSessionStatusResult {
  if (!isRecord(error)) return failure(undefined);
  if (
    error.code === "slack_webapi_rate_limited_error" &&
    typeof error.retryAfter === "number" &&
    Number.isFinite(error.retryAfter) &&
    error.retryAfter >= 0 &&
    error.retryAfter <= Number.MAX_SAFE_INTEGER / 1_000
  )
    return { kind: "rate-limited", retryAfterMs: error.retryAfter * 1_000 };
  if (isRecord(error.data)) return failure(error.data.error);
  return failure(undefined);
}

export class AgentSessionStatusAdapter implements AgentSessionStatusWriter {
  readonly #client: AgentSessionStatusClient;
  readonly #assertOwned: (() => void) | undefined;

  constructor(client: AgentSessionStatusClient, options: { assertOwned?: () => void } = {}) {
    this.#client = client;
    this.#assertOwned = options.assertOwned;
  }

  async setStatus(
    target: AgentSessionTarget,
    status: AgentSessionStatus,
  ): Promise<AgentSessionStatusResult> {
    try {
      this.#assertOwned?.();
    } catch {
      return { kind: "unavailable", scope: "team", reason: "runtime_ownership_lost" };
    }
    try {
      const response = await this.#client.apiCall("agents.sessions.setStatus", {
        channel_id: target.channelId,
        thread_ts: target.threadTs,
        status,
      });
      if (!isRecord(response)) return { kind: "retry", reason: "invalid_response" };
      if (response.ok !== true) return failure(response.error);
      if (response.agent_status !== undefined && response.agent_status !== status)
        return { kind: "retry", reason: "unexpected_agent_status" };
      return { kind: "applied" };
    } catch (error) {
      return rejected(error);
    }
  }
}
