import { randomUUID } from "node:crypto";

import type { AppServerRequest } from "../codex/app-server-client.js";
import { redactSensitiveText } from "./redact-sensitive.js";

export interface NativeInputBinding {
  eventId: string;
  threadId: string;
  turnId?: string;
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
}

interface NativeInputIdentity {
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
}

interface NativeInputRelayOptions {
  agentName?: string;
  redactSensitiveText?: (text: string) => string;
  postApproval: (input: {
    approvalId: string;
    expiresAt: string;
    summary: string;
    userId: string;
    channelId: string;
    threadTs: string;
  }) => Promise<void>;
  postInfo: (input: {
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
  }) => Promise<void>;
  onChange?: (binding: NativeInputBinding) => void;
}

interface PreparedInput {
  kind: "approval" | "answer" | "local";
  summary: string;
  accept?: unknown;
  decline: unknown;
  cancel: unknown;
  answer?: (text: string) => unknown;
}

interface PendingInput {
  id: string;
  request: AppServerRequest;
  binding: NativeInputBinding;
  prepared: PreparedInput;
  fingerprint: string;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

const inputLifetimeMs = 10 * 60_000;
const maximumInputCharacters = 16_000;
const maximumPreviewCharacters = 2_700;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInput(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function jsonText(value: unknown): string {
  const text = JSON.stringify(value);
  requireInput(typeof text === "string", "Codex returned an unsupported input payload.");
  if (text === undefined) throw new Error("Codex returned an unsupported input payload.");
  requireInput(text.length <= maximumInputCharacters, "Complete this large Codex request locally.");
  return text;
}

function containsHiddenCharacters(text: string): boolean {
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return true;
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 10) || (code >= 127 && code <= 159);
  });
}

function preview(value: string, redact: (text: string) => string): string {
  requireInput(
    value.length <= maximumPreviewCharacters,
    "Complete this native request locally because its full scope cannot fit in a Slack prompt.",
  );
  requireInput(
    !containsHiddenCharacters(value),
    "Complete this native request locally because its scope contains hidden display characters.",
  );
  requireInput(
    redact(value) === value,
    "Complete this native request locally because its full scope contains sensitive values that cannot be shown in Slack.",
  );
  return value;
}

function sameIdentity(binding: NativeInputBinding, identity: NativeInputIdentity): boolean {
  return (
    binding.teamId === identity.teamId &&
    binding.userId === identity.userId &&
    binding.channelId === identity.channelId &&
    binding.threadTs === identity.threadTs
  );
}

function questionAnswer(questions: unknown[], text: string): unknown {
  let values: unknown;
  const question = questions[0];
  if (questions.length === 1 && isRecord(question) && !text.trimStart().startsWith("{")) {
    values = { [String(question.id)]: text.trim() };
  } else {
    values = JSON.parse(text);
  }
  requireInput(isRecord(values), "Answer every question using its displayed ID.");
  if (!isRecord(values)) throw new Error("Answer every question using its displayed ID.");
  const answers = questions.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") throw new Error("Invalid question ID.");
    const raw = values[entry.id];
    let submitted: string[] = [];
    if (typeof raw === "string") submitted = [raw.trim()];
    if (Array.isArray(raw) && raw.every((value) => typeof value === "string")) submitted = raw;
    requireInput(
      submitted.length > 0 && submitted.every((value) => value.trim().length > 0),
      "Answer every question using its displayed ID.",
    );
    const options = entry.options;
    if (Array.isArray(options) && options.length > 0 && entry.isOther !== true) {
      submitted = submitted.map((value) => {
        const option = options.find(
          (candidate: unknown) =>
            isRecord(candidate) &&
            typeof candidate.label === "string" &&
            candidate.label.toLowerCase() === value.toLowerCase(),
        );
        if (isRecord(option) && typeof option.label === "string") return option.label;
        return value;
      });
      requireInput(
        submitted.every((value) =>
          options.some((option: unknown) => isRecord(option) && option.label === value),
        ),
        "Choose one of the displayed options.",
      );
    }
    return [entry.id, { answers: submitted }];
  });
  requireInput(
    Object.keys(values).length === questions.length,
    "Use only the displayed question IDs.",
  );
  return { answers: Object.fromEntries(answers) };
}

function formMatches(value: unknown, schema: unknown, depth = 0): boolean {
  if (!isRecord(schema) || depth > 5) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((option) => isRecord(option) && option.const === value);
  }
  if (Array.isArray(schema.oneOf)) {
    if (!schema.oneOf.some((option) => isRecord(option) && option.const === value)) return false;
  }
  if (schema.type === "string") {
    return (
      typeof value === "string" &&
      (typeof schema.minLength !== "number" || [...value].length >= schema.minLength) &&
      (typeof schema.maxLength !== "number" || [...value].length <= schema.maxLength)
    );
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (schema.type !== "integer" || Number.isInteger(value)) &&
      (typeof schema.minimum !== "number" || value >= schema.minimum) &&
      (typeof schema.maximum !== "number" || value <= schema.maximum)
    );
  }
  if (schema.type === "array") {
    return (
      Array.isArray(value) &&
      value.length <= 100 &&
      (typeof schema.minItems !== "number" || value.length >= schema.minItems) &&
      (typeof schema.maxItems !== "number" || value.length <= schema.maxItems) &&
      value.every((entry) => formMatches(entry, schema.items, depth + 1))
    );
  }
  if (schema.type !== "object" || !isRecord(value) || !isRecord(schema.properties)) return false;
  const properties = schema.properties;
  if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
  if (
    Array.isArray(schema.required) &&
    schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(value, key))
  )
    return false;
  return Object.entries(value).every(([key, entry]) =>
    formMatches(entry, properties[key], depth + 1),
  );
}

function validPermissions(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some((key) => key !== "network" && key !== "fileSystem")) return false;
  if (value.network != null) {
    if (!isRecord(value.network) || Object.keys(value.network).some((key) => key !== "enabled"))
      return false;
    if (value.network.enabled !== null && typeof value.network.enabled !== "boolean") return false;
  }
  if (value.fileSystem != null) {
    if (!isRecord(value.fileSystem)) return false;
    const fileSystem = value.fileSystem;
    if (
      Object.keys(fileSystem).some(
        (key) => !["read", "write", "entries", "globScanMaxDepth"].includes(key),
      )
    )
      return false;
    for (const key of ["read", "write"]) {
      const paths = fileSystem[key];
      if (
        paths != null &&
        (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string"))
      )
        return false;
    }
    if (
      fileSystem.globScanMaxDepth !== undefined &&
      (!Number.isSafeInteger(fileSystem.globScanMaxDepth) ||
        typeof fileSystem.globScanMaxDepth !== "number" ||
        fileSystem.globScanMaxDepth < 0)
    )
      return false;
    if (fileSystem.entries !== undefined) {
      if (
        !Array.isArray(fileSystem.entries) ||
        !fileSystem.entries.every((entry: unknown) => {
          if (
            !isRecord(entry) ||
            !isRecord(entry.path) ||
            !["read", "write", "deny"].includes(String(entry.access))
          )
            return false;
          if (Object.keys(entry).some((key) => key !== "path" && key !== "access")) return false;
          const path = entry.path;
          if (path.type === "path")
            return typeof path.path === "string" && Object.keys(path).length === 2;
          if (path.type === "glob_pattern")
            return typeof path.pattern === "string" && Object.keys(path).length === 2;
          if (path.type === "special")
            return isRecord(path.value) && Object.keys(path).length === 2;
          return false;
        })
      )
        return false;
    }
  }
  return true;
}

function prepareInput(
  request: AppServerRequest,
  agentName: string,
  redact: (text: string) => string,
): PreparedInput {
  if (!isRecord(request.params))
    throw new Error(`${agentName} returned invalid request parameters.`);
  const params = request.params;
  const reason = typeof params.reason === "string" ? params.reason : "";
  const decisions = { decline: { decision: "decline" }, cancel: { decision: "cancel" } };
  if (request.method === "item/commandExecution/requestApproval") {
    const lines = [`Approve this ${agentName} action once?`];
    if (params.kind === "writeStdin") lines.push("Action: send input to an existing terminal.");
    if (isRecord(params.networkApprovalContext)) {
      requireInput(
        typeof params.networkApprovalContext.host === "string" &&
          params.networkApprovalContext.host.trim().length > 0 &&
          typeof params.networkApprovalContext.protocol === "string" &&
          params.networkApprovalContext.protocol.trim().length > 0,
        `Complete this network approval locally; ${agentName} did not identify its target.`,
      );
      lines.push(`Network access: ${jsonText(params.networkApprovalContext)}`);
    } else {
      requireInput(
        typeof params.command === "string" && params.command.trim().length > 0,
        `Complete this approval locally; ${agentName} did not provide a reviewable command.`,
      );
    }
    if (typeof params.command === "string") lines.push(params.command);
    if (typeof params.cwd === "string") lines.push(`Working directory: ${params.cwd}`);
    if (params.additionalPermissions != null)
      lines.push(`Requested permissions: ${jsonText(params.additionalPermissions)}`);
    if (reason.length > 0) lines.push(reason);
    requireInput(
      params.availableDecisions == null ||
        (Array.isArray(params.availableDecisions) && params.availableDecisions.includes("accept")),
      `Complete this approval locally; ${agentName} did not offer a one-time approval.`,
    );
    return {
      kind: "approval",
      summary: preview(lines.join("\n\n"), redact),
      accept: { decision: "accept" },
      ...decisions,
    };
  }
  if (request.method === "item/fileChange/requestApproval") {
    const lines = [`Approve this ${agentName} file change once?`];
    const scopes = [
      ["Changes", params.changes],
      ["Paths", params.paths],
      ["Write scope", params.grantRoot],
    ].filter(([, value]) => value != null);
    requireInput(
      scopes.length > 0,
      `Complete this file approval locally; ${agentName} did not provide its changed paths or write scope.`,
    );
    for (const [label, scope] of scopes) lines.push(`${label}: ${jsonText(scope)}`);
    if (reason.length > 0) lines.push(reason);
    return {
      kind: "approval",
      summary: preview(lines.join("\n\n"), redact),
      accept: { decision: "accept" },
      ...decisions,
    };
  }
  if (request.method === "item/permissions/requestApproval") {
    requireInput(
      isRecord(params.permissions),
      `${agentName} did not provide a reviewable permission request.`,
    );
    if (!isRecord(params.permissions)) throw new Error("Invalid permission request.");
    requireInput(
      validPermissions(params.permissions),
      "Complete this unsupported permission request locally.",
    );
    const permissions = Object.fromEntries(
      Object.entries(params.permissions).filter(([, value]) => value !== null),
    );
    const copy: unknown = JSON.parse(jsonText(permissions));
    const cancelled = { permissions: {}, scope: "turn" };
    return {
      kind: "approval",
      summary: preview(
        [
          `Grant exactly these ${agentName} permissions for this turn?`,
          jsonText(permissions),
          reason,
        ]
          .filter(Boolean)
          .join("\n\n"),
        redact,
      ),
      accept: { permissions: copy, scope: "turn" },
      decline: cancelled,
      cancel: cancelled,
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    requireInput(
      Array.isArray(params.questions) &&
        params.questions.length > 0 &&
        params.questions.length <= 10,
      `${agentName} did not provide supported questions.`,
    );
    if (!Array.isArray(params.questions)) throw new Error("Invalid questions.");
    const questions = params.questions;
    const ids = new Set<string>();
    const descriptions = questions.map((question) => {
      requireInput(
        isRecord(question) &&
          typeof question.id === "string" &&
          typeof question.question === "string",
        `${agentName} returned an invalid question.`,
      );
      if (!isRecord(question) || typeof question.id !== "string")
        throw new Error("Invalid question.");
      requireInput(
        question.isSecret !== true,
        "Complete this secret input locally. Secret values cannot be requested through Slack.",
      );
      requireInput(!ids.has(question.id), `${agentName} returned duplicate question IDs.`);
      ids.add(question.id);
      const options: string[] = [];
      if (Array.isArray(question.options)) {
        for (const option of question.options) {
          requireInput(
            isRecord(option) &&
              typeof option.label === "string" &&
              typeof option.description === "string",
            `${agentName} returned an invalid question option.`,
          );
          if (isRecord(option))
            options.push(`${String(option.label)}: ${String(option.description)}`);
        }
      }
      return [`${question.id}: ${String(question.question)}`, ...options].join("\n");
    });
    return {
      kind: "answer",
      summary: preview(descriptions.join("\n\n"), redact),
      decline: { answers: {} },
      cancel: { answers: {} },
      answer: (text) => questionAnswer(questions, text),
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    const cancelled = { action: "cancel", content: null, _meta: null };
    if (params.mode === "url" || params.mode === "openai/userVerification") {
      return {
        kind: "local",
        summary: `${agentName} requires a local sign-in or verification step. Complete it in ${agentName} on this Mac. Slack has not opened a URL, submitted verification, or approved this request.`,
        decline: cancelled,
        cancel: cancelled,
      };
    }
    requireInput(
      params.mode === "form" || params.mode === "openai/form" || params.mode === "openaiForm",
      `Complete this unsupported ${agentName} elicitation locally.`,
    );
    requireInput(
      isRecord(params.requestedSchema),
      `${agentName} did not provide a supported form schema.`,
    );
    const schema = params.requestedSchema;
    const schemaText = jsonText(schema);
    requireInput(
      !/"(?:password|passwd|secret|token|authorization|api[_-]?key|private[_-]?key)"\s*:/iu.test(
        schemaText,
      ),
      "Complete this secret form locally. Secret values cannot be requested through Slack.",
    );
    return {
      kind: "answer",
      summary: preview(
        [
          typeof params.message === "string" ? params.message : `${agentName} requests this form:`,
          schemaText,
          "Reply with a JSON object matching these fields.",
        ].join("\n\n"),
        redact,
      ),
      decline: { action: "decline", content: null, _meta: null },
      cancel: cancelled,
      answer: (text) => {
        const content: unknown = JSON.parse(text);
        requireInput(
          formMatches(content, schema),
          "The answer must match the displayed form schema.",
        );
        return { action: "accept", content, _meta: null };
      },
    };
  }
  throw new Error(
    `Complete this unsupported ${agentName} request locally: ${request.method.slice(0, 150)}.`,
  );
}

export class NativeInputRelay {
  readonly #options: NativeInputRelayOptions;
  readonly #pending = new Map<string, PendingInput>();
  readonly #redact: (text: string) => string;
  #closed = false;

  constructor(options: NativeInputRelayOptions) {
    this.#options = options;
    this.#redact = options.redactSensitiveText ?? redactSensitiveText;
  }

  async request(request: AppServerRequest, binding: NativeInputBinding): Promise<unknown> {
    requireInput(!this.#closed, "The native Slack input relay is closed.");
    try {
      requireInput(
        isRecord(request.params) && request.params.threadId === binding.threadId,
        `The ${this.#options.agentName ?? "Codex"} input does not belong to this Slack conversation.`,
      );
      if (!isRecord(request.params)) throw new Error("Invalid native request.");
      if (request.method === "currentTime/read") {
        return { currentTimeAt: Math.floor(Date.now() / 1_000) };
      }
      if (request.method === "mcpServer/elicitation/request" && request.params.turnId === null) {
        requireInput(
          typeof request.params.serverName === "string",
          `${this.#options.agentName ?? "Codex"} did not identify the eliciting server.`,
        );
      } else {
        requireInput(
          typeof binding.turnId === "string" && request.params.turnId === binding.turnId,
          `The ${this.#options.agentName ?? "Codex"} input does not belong to the active turn.`,
        );
      }
      const fingerprint = jsonText({ method: request.method, params: request.params, binding });
      const existing = [...this.#pending.values()].find(
        (entry) => entry.binding.threadId === binding.threadId && entry.request.id === request.id,
      );
      if (existing !== undefined) {
        requireInput(
          existing.fingerprint === fingerprint,
          "The native request changed before it was answered.",
        );
        return existing.promise;
      }
      const prepared = prepareInput(request, this.#options.agentName ?? "Codex", this.#redact);
      if (prepared.kind === "local") {
        await this.#postInfo(binding, prepared.summary);
        return prepared.cancel;
      }
      const id = randomUUID();
      const expiresAt = Date.now() + inputLifetimeMs;
      let resolve: (value: unknown) => void = () => {};
      const promise = new Promise<unknown>((answer) => {
        resolve = answer;
      });
      const timer = setTimeout(() => {
        const entry = this.#pending.get(id);
        if (entry !== undefined) {
          this.#finish(entry, prepared.cancel);
          void this.#postInfo(
            binding,
            `This ${this.#options.agentName ?? "Codex"} request expired without approval.`,
          ).catch(() => {});
        }
      }, inputLifetimeMs);
      timer.unref();
      const entry: PendingInput = {
        id,
        request,
        binding: { ...binding },
        prepared,
        fingerprint,
        promise,
        resolve,
        timer,
        expiresAt,
      };
      this.#pending.set(id, entry);
      this.#options.onChange?.(binding);
      try {
        if (prepared.kind === "approval") {
          await this.#options.postApproval({
            approvalId: id,
            expiresAt: new Date(expiresAt).toISOString(),
            summary: prepared.summary,
            userId: binding.userId,
            channelId: binding.channelId,
            threadTs: binding.threadTs,
          });
        } else {
          await this.#postInfo(
            binding,
            `${prepared.summary}\n\nReply in this thread: answer ${id} <your answer>`,
          );
        }
      } catch {
        this.#finish(entry, prepared.cancel);
        throw new Error(
          `The ${this.#options.agentName ?? "Codex"} request could not be presented in Slack.`,
        );
      }
      return promise;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `The native ${this.#options.agentName ?? "Codex"} input could not be relayed.`;
      await this.#postInfo(binding, this.#redact(message).slice(0, maximumPreviewCharacters)).catch(
        () => {},
      );
      throw new Error(this.#redact(message));
    }
  }

  approve(input: NativeInputIdentity & { approvalId: string; approved: boolean }): boolean {
    const entry = this.#pending.get(input.approvalId);
    if (
      entry === undefined ||
      entry.prepared.kind !== "approval" ||
      !sameIdentity(entry.binding, input) ||
      Date.now() >= entry.expiresAt
    )
      return false;
    let response = entry.prepared.decline;
    if (input.approved) response = entry.prepared.accept;
    this.#finish(entry, response);
    return true;
  }

  answer(input: NativeInputIdentity & { text: string }): boolean {
    const match = /^answer\s+([a-f\d-]{36})\s+([\s\S]+)$/iu.exec(input.text.trim());
    const id = match?.[1];
    const text = match?.[2];
    if (id === undefined || text === undefined) return false;
    const entry = this.#pending.get(id);
    if (
      entry === undefined ||
      entry.prepared.kind !== "answer" ||
      entry.prepared.answer === undefined ||
      !sameIdentity(entry.binding, input) ||
      Date.now() >= entry.expiresAt
    )
      return false;
    try {
      requireInput(
        text.length <= maximumInputCharacters && this.#redact(text) === text,
        "Do not submit secrets through Slack.",
      );
      const response = entry.prepared.answer(text);
      this.#finish(entry, response);
      return true;
    } catch {
      void this.#postInfo(
        entry.binding,
        "That answer was not accepted. Use the displayed question IDs and schema, and keep secret values local.",
      ).catch(() => {});
      return false;
    }
  }

  answerPending(
    input: NativeInputIdentity & { text: string },
  ): "accepted" | "not-answer" | "invalid" {
    const entries = [...this.#pending.values()].filter(
      (entry) =>
        entry.prepared.kind === "answer" &&
        sameIdentity(entry.binding, input) &&
        Date.now() < entry.expiresAt,
    );
    if (entries.length !== 1) return "not-answer";
    const entry = entries[0];
    if (entry?.prepared.answer === undefined) return "not-answer";
    if (input.text.length > maximumInputCharacters || this.#redact(input.text) !== input.text)
      return "invalid";
    try {
      requireInput(
        input.text.length <= maximumInputCharacters && this.#redact(input.text) === input.text,
        "Do not submit secrets through Slack.",
      );
      const response = entry.prepared.answer(input.text);
      this.#finish(entry, response);
      return "accepted";
    } catch {
      return "not-answer";
    }
  }

  pendingCount(identity: NativeInputIdentity): number {
    return [...this.#pending.values()].filter(
      (entry) => sameIdentity(entry.binding, identity) && Date.now() < entry.expiresAt,
    ).length;
  }

  invalidateAnswers(threadId: string): void {
    for (const entry of this.#pending.values()) {
      if (entry.binding.threadId === threadId && entry.prepared.kind === "answer")
        this.#finish(entry, entry.prepared.cancel);
    }
  }

  invalidateThread(threadId: string): void {
    for (const entry of this.#pending.values()) {
      if (entry.binding.threadId === threadId) this.#finish(entry, entry.prepared.cancel);
    }
  }

  resolved(threadId: string, requestId: string | number): void {
    for (const entry of this.#pending.values()) {
      if (entry.binding.threadId === threadId && entry.request.id === requestId)
        this.#finish(entry, entry.prepared.cancel);
    }
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#pending.values()) this.#finish(entry, entry.prepared.cancel);
  }

  #finish(entry: PendingInput, response: unknown): void {
    if (this.#pending.get(entry.id) !== entry) return;
    this.#pending.delete(entry.id);
    clearTimeout(entry.timer);
    entry.resolve(response);
    this.#options.onChange?.(entry.binding);
  }

  #postInfo(binding: NativeInputBinding, text: string): Promise<void> {
    return this.#options.postInfo({
      channelId: binding.channelId,
      threadTs: binding.threadTs,
      userId: binding.userId,
      text,
    });
  }
}
