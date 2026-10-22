import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  ConversationDispatchRejectedError,
  ConversationSteerUnavailableError,
} from "../agents/conversation-backend.js";
import type {
  AppServerMessageHandler,
  AppServerRequestHandler,
} from "../codex/app-server-client.js";
import {
  claudeChildEnvironment,
  claudeExecutable,
  claudeSubscriptionSettings,
  inspectClaudeReadiness,
  type ClaudeReadiness,
} from "./readiness.js";

export { inspectClaudeReadiness } from "./readiness.js";

type Item = Record<string, unknown>;
interface Turn {
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  items: Item[];
  error?: { message: string };
}
interface Session {
  id: string;
  cwd: string;
  initialized: boolean;
  turns: Turn[];
}
interface Control {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
interface Running {
  child: ChildProcessWithoutNullStreams;
  reader: readline.Interface;
  session: Session;
  turn: Turn;
  controls: Map<string, Control>;
  requests: Set<string>;
  result?: Record<string, unknown>;
  state?: string;
  inputEnded: boolean;
  promptSent: boolean;
  interruptAcknowledged: boolean;
  closed: Promise<void>;
  resolveClosed: () => void;
  failed: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uuid(value: string): string {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value)) {
    throw new Error("Invalid Claude session or turn identity");
  }
  return value;
}
function absolute(value: string): string {
  if (!path.isAbsolute(value) || /\p{Cc}/u.test(value))
    throw new Error("Claude paths must be absolute");
  return value;
}
function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return "Claude Code failed";
}
function parseSession(value: unknown, id: string): Session {
  if (
    !record(value) ||
    value.id !== id ||
    typeof value.cwd !== "string" ||
    typeof value.initialized !== "boolean" ||
    !Array.isArray(value.turns)
  )
    throw new Error("Invalid Claude session ledger");
  const turns: Turn[] = [];
  for (const entry of value.turns) {
    if (
      !record(entry) ||
      typeof entry.id !== "string" ||
      !Array.isArray(entry.items) ||
      !entry.items.every(record)
    )
      throw new Error("Invalid Claude turn ledger");
    if (
      entry.status !== "inProgress" &&
      entry.status !== "completed" &&
      entry.status !== "failed" &&
      entry.status !== "interrupted"
    )
      throw new Error("Invalid Claude turn status");
    const turn: Turn = { id: uuid(entry.id), status: entry.status, items: entry.items };
    if (record(entry.error) && typeof entry.error.message === "string")
      turn.error = { message: entry.error.message };
    turns.push(turn);
  }
  return { id: uuid(id), cwd: absolute(value.cwd), initialized: value.initialized, turns };
}

export class ClaudeConversation {
  readonly #options: {
    executablePath?: string;
    model?: string;
    developerInstructions?: string;
    stateDirectory?: string;
    cwd?: string;
  };
  readonly #handlers = new Set<AppServerMessageHandler>();
  readonly #sessions = new Map<string, Session>();
  readonly #running = new Map<string, Running>();
  readonly #writes = new Map<string, Promise<void>>();
  #requestHandler: AppServerRequestHandler | undefined;
  #closed = false;
  #closing?: Promise<void>;

  constructor(
    options: {
      executablePath?: string;
      model?: string;
      developerInstructions?: string;
      stateDirectory?: string;
      cwd?: string;
    } = {},
  ) {
    this.#options = options;
    claudeExecutable(options.executablePath);
    if (options.stateDirectory !== undefined) absolute(options.stateDirectory);
    if (options.cwd !== undefined) absolute(options.cwd);
    if (options.model !== undefined && (!options.model.trim() || /\p{Cc}/u.test(options.model)))
      throw new Error("Invalid Claude model");
  }

  async readiness(): Promise<ClaudeReadiness> {
    this.#assertOpen();
    return inspectClaudeReadiness(this.#options);
  }
  async start(): Promise<void> {
    await this.readiness();
  }
  async validateTurn(text: string, imagePaths: readonly string[] = []): Promise<void> {
    this.#assertOpen();
    if (!text.trim() && imagePaths.length === 0)
      throw new Error("A Claude turn requires user text or an image");
    for (const imagePath of imagePaths) {
      if (
        ![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(
          path.extname(absolute(imagePath)).toLowerCase(),
        )
      )
        throw new Error("Unsupported Claude image format");
      const bytes = await readFile(imagePath);
      if (bytes.length > 20 * 1024 * 1024) throw new Error("Claude image exceeds 20 MiB");
    }
    await this.readiness();
  }
  async startThread(cwd: string): Promise<string> {
    this.#assertOpen();
    const session: Session = {
      id: randomUUID(),
      cwd: absolute(cwd),
      initialized: false,
      turns: [],
    };
    this.#sessions.set(session.id, session);
    await this.#save(session);
    return session.id;
  }
  async resumeThread(threadId: string, cwd: string): Promise<void> {
    this.#assertOpen();
    const session = await this.#load(threadId);
    if (session.cwd !== absolute(cwd))
      throw new Error("Claude session belongs to a different directory");
    if (session.turns.some((turn) => turn.status === "inProgress"))
      throw new Error(
        `The previous Claude turn has no terminal evidence; inspect it locally with claude --resume ${session.id} before resuming`,
      );
  }
  async startTurn(
    threadId: string,
    text: string,
    imagePaths: string[] = [],
    _clientUserMessageId?: string,
  ): Promise<string> {
    const dispatch = { sent: false };
    try {
      return await this.#startTurn(threadId, text, imagePaths, dispatch);
    } catch (error) {
      if (!dispatch.sent) throw new ConversationDispatchRejectedError(errorText(error));
      throw error;
    }
  }
  async #startTurn(
    threadId: string,
    text: string,
    imagePaths: string[],
    dispatch: { sent: boolean },
  ): Promise<string> {
    this.#assertOpen();
    if (!text.trim() && imagePaths.length === 0)
      throw new Error("A Claude turn requires user text or an image");
    const session = await this.#load(threadId);
    if (this.#running.has(threadId) || session.turns.some((turn) => turn.status === "inProgress"))
      throw new Error(
        `A Claude turn is already active or unconfirmed; inspect locally with claude --resume ${session.id}`,
      );
    await inspectClaudeReadiness({ ...this.#options, cwd: session.cwd });
    this.#assertOpen();
    if (this.#running.has(threadId) || session.turns.some((turn) => turn.status === "inProgress"))
      throw new Error(
        `A Claude turn is already active or unconfirmed; inspect locally with claude --resume ${session.id}`,
      );
    const content: Record<string, unknown>[] = [{ type: "text", text }];
    for (const imagePath of imagePaths) {
      const extension = path.extname(absolute(imagePath)).toLowerCase();
      const mediaTypes: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
      };
      const mediaType = mediaTypes[extension];
      if (mediaType === undefined) throw new Error("Unsupported Claude image format");
      const bytes = await readFile(imagePath);
      if (bytes.length > 20 * 1024 * 1024) throw new Error("Claude image exceeds 20 MiB");
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
      });
    }
    const turn: Turn = { id: randomUUID(), status: "inProgress", items: [] };
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--replay-user-messages",
      "--permission-prompt-tool",
      "stdio",
      "--settings",
      claudeSubscriptionSettings,
    ];
    if (session.initialized) args.push(`--resume=${session.id}`);
    else args.push(`--session-id=${session.id}`);
    if (this.#options.model !== undefined) args.push(`--model=${this.#options.model}`);
    let promptFile: string | undefined;
    let childToClose: Running | undefined;
    try {
      if (this.#options.developerInstructions !== undefined) {
        const directory = this.#options.stateDirectory;
        if (directory === undefined) throw new Error("Claude persona requires a state directory");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        promptFile = path.join(directory, `persona-${turn.id}.txt`);
        await writeFile(promptFile, this.#options.developerInstructions, { mode: 0o600 });
        args.push("--append-system-prompt-file", promptFile);
      }
      if (
        this.#running.has(threadId) ||
        session.turns.some((entry) => entry.status === "inProgress")
      )
        throw new Error(
          `A Claude turn is already active or unconfirmed; inspect locally with claude --resume ${session.id}`,
        );
      session.turns.push(turn);
      await this.#save(session);
      this.#assertOpen();
      const child = spawn(claudeExecutable(this.#options.executablePath), args, {
        cwd: session.cwd,
        env: claudeChildEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let resolveClosed = (): void => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const reader = readline.createInterface({ input: child.stdout });
      const running: Running = {
        child,
        reader,
        session,
        turn,
        controls: new Map(),
        requests: new Set(),
        inputEnded: false,
        promptSent: false,
        interruptAcknowledged: false,
        closed,
        resolveClosed,
        failed: false,
      };
      childToClose = running;
      this.#running.set(threadId, running);
      child.stderr.resume();
      child.stdin.on("error", () => this.#fail(running, "Claude input stream closed unexpectedly"));
      child.once("error", () => this.#fail(running, "Claude Code could not be launched"));
      reader.on("line", (line) => {
        try {
          const message: unknown = JSON.parse(line);
          if (record(message)) this.#message(running, message);
        } catch {
          this.#fail(running, "Claude returned invalid stream data");
        }
      });
      child.once("close", (code, signal) => {
        void this.#finished(running, code, signal)
          .catch(() => {
            running.turn.status = "inProgress";
            this.#emit("turn/uncertain", running, {
              error: {
                message: `Claude terminal evidence could not be persisted. Inspect locally with claude --resume ${running.session.id} before continuing.`,
              },
            });
          })
          .finally(() => {
            if (promptFile !== undefined) void rm(promptFile, { force: true });
            resolveClosed();
          });
      });
      const initialized = await this.#control(running, { subtype: "initialize", hooks: null });
      if (
        !record(initialized) ||
        !record(initialized.account) ||
        initialized.account.apiProvider !== "firstParty" ||
        typeof initialized.account.subscriptionType !== "string" ||
        !/^(?:Claude )?(?:Pro|Max|Team|Enterprise)$/iu.test(initialized.account.subscriptionType) ||
        (initialized.account.apiKeySource !== undefined &&
          initialized.account.apiKeySource !== "none")
      )
        throw new Error("Claude initialized without a verified subscription account");
      if (
        !["default", "manual", "auto", "acceptEdits", "plan", "dontAsk"].includes(
          String(initialized.current_permission_mode),
        )
      )
        throw new Error("Claude initialized with an unexpected permission mode");
      this.#assertOpen();
      this.#emit("turn/started", running, {
        turn: { id: turn.id, status: "inProgress", items: [] },
      });
      running.promptSent = true;
      dispatch.sent = true;
      this.#send(running, {
        type: "user",
        uuid: turn.id,
        session_id: session.id,
        parent_tool_use_id: null,
        client_composed: true,
        message: { role: "user", content },
      });
      return turn.id;
    } catch (error) {
      try {
        if (!dispatch.sent && session.turns.includes(turn)) {
          turn.status = "failed";
          turn.error = { message: errorText(error) };
          await this.#save(session);
        }
      } finally {
        if (childToClose !== undefined) await this.#terminate(childToClose);
        if (promptFile !== undefined) await rm(promptFile, { force: true });
      }
      throw error;
    }
  }
  async steer(
    _threadId: string,
    _turnId: string,
    _text: string,
    _clientUserMessageId?: string,
  ): Promise<void> {
    throw new ConversationSteerUnavailableError();
  }
  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.#assertOpen();
    const running = this.#running.get(uuid(threadId));
    if (running === undefined || running.turn.id !== uuid(turnId))
      throw new Error("No matching active Claude turn to interrupt");
    await this.#control(running, { subtype: "interrupt" });
    running.interruptAcknowledged = true;
    this.#cancelRequests(running);
  }
  async readThread(threadId: string): Promise<unknown> {
    const session = await this.#load(threadId);
    return { thread: { id: session.id, turns: structuredClone(session.turns) } };
  }
  async readTurn(threadId: string, turnId: string): Promise<Record<string, unknown> | undefined> {
    const session = await this.#load(threadId);
    const turn = session.turns.find((entry) => entry.id === uuid(turnId));
    if (turn === undefined) return undefined;
    return { ...structuredClone(turn) };
  }
  subscribe(handler: AppServerMessageHandler): () => void {
    this.#assertOpen();
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  subscribeRequests(handler: AppServerRequestHandler): () => void {
    this.#assertOpen();
    if (this.#requestHandler !== undefined)
      throw new Error("A Claude interaction handler is already registered");
    this.#requestHandler = handler;
    return () => {
      if (this.#requestHandler === handler) this.#requestHandler = undefined;
    };
  }
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#closing = Promise.all(
      [...this.#running.values()].map((running) => this.#terminate(running)),
    ).then(() => {
      this.#handlers.clear();
      this.#requestHandler = undefined;
    });
    return this.#closing;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error("The Claude conversation is closed");
  }
  async #load(id: string): Promise<Session> {
    uuid(id);
    const existing = this.#sessions.get(id);
    if (existing !== undefined) return existing;
    const directory = this.#options.stateDirectory;
    if (directory === undefined) throw new Error("Claude session is unavailable");
    const data: unknown = JSON.parse(await readFile(path.join(directory, `${id}.json`), "utf8"));
    const session = parseSession(data, id);
    this.#sessions.set(id, session);
    return session;
  }
  async #save(session: Session): Promise<void> {
    const directory = this.#options.stateDirectory;
    if (directory === undefined) return;
    const serialized = JSON.stringify(session);
    const previous = this.#writes.get(session.id) ?? Promise.resolve();
    const writing = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = path.join(directory, `${session.id}-${randomUUID()}.tmp`);
        await writeFile(temporary, serialized, { mode: 0o600 });
        await rename(temporary, path.join(directory, `${session.id}.json`));
      });
    this.#writes.set(session.id, writing);
    await writing;
  }
  #send(running: Running, message: unknown): void {
    if (
      running.child.exitCode !== null ||
      running.child.signalCode !== null ||
      running.inputEnded ||
      running.failed
    )
      throw new Error("Claude transport is unavailable");
    running.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  #control(running: Running, request: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        running.controls.delete(id);
        reject(new Error("Claude control request timed out"));
      }, 60_000);
      running.controls.set(id, { resolve, reject, timer });
      try {
        this.#send(running, { type: "control_request", request_id: id, request });
      } catch (error) {
        clearTimeout(timer);
        running.controls.delete(id);
        reject(new Error(errorText(error)));
      }
    });
  }
  #message(running: Running, message: Record<string, unknown>): void {
    if (running.failed) return;
    if (typeof message.session_id === "string" && message.session_id !== running.session.id) {
      this.#fail(running, "Claude returned a different session identity");
      return;
    }
    if (message.type === "control_response" && record(message.response)) {
      const response = message.response;
      if (typeof response.request_id !== "string") return;
      const pending = running.controls.get(response.request_id);
      if (pending === undefined) return;
      running.controls.delete(response.request_id);
      clearTimeout(pending.timer);
      if (response.subtype === "success") pending.resolve(response.response);
      else pending.reject(new Error("Claude rejected a control request"));
      return;
    }
    if (
      message.type === "control_request" &&
      typeof message.request_id === "string" &&
      record(message.request)
    ) {
      running.requests.add(message.request_id);
      void this.#permission(running, message.request_id, message.request);
      return;
    }
    if (message.type === "control_cancel_request" && typeof message.request_id === "string") {
      running.requests.delete(message.request_id);
      this.#emit("serverRequest/resolved", running, { requestId: message.request_id });
      return;
    }
    if (message.type === "system") {
      if (message.subtype === "init") {
        if (message.apiKeySource !== "none") {
          this.#fail(running, "Claude switched away from subscription authentication");
          return;
        }
        running.session.initialized = true;
        void this.#save(running.session).catch(() =>
          this.#fail(running, "Claude session evidence could not be persisted"),
        );
      }
      if (message.subtype === "session_state_changed" && typeof message.state === "string") {
        running.state = message.state;
        this.#endInput(running);
      }
      return;
    }
    if (
      message.type === "assistant" &&
      record(message.message) &&
      Array.isArray(message.message.content)
    ) {
      for (let index = 0; index < message.message.content.length; index += 1) {
        const block: unknown = message.message.content[index];
        if (!record(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          const itemId = `${String(message.message.id ?? message.uuid ?? running.turn.id)}-${index}`;
          this.#item(running, {
            id: itemId,
            type: "agentMessage",
            text: block.text,
            phase: "commentary",
          });
        }
        if (
          block.type === "tool_use" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          this.#item(running, {
            id: block.id,
            type: "dynamicToolCall",
            tool: block.name,
            status: "inProgress",
          });
        }
      }
      return;
    }
    if (message.type === "stream_event" && record(message.event)) {
      const event = message.event;
      if (
        event.type === "content_block_delta" &&
        record(event.delta) &&
        event.delta.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        this.#emit("item/agentMessage/delta", running, {
          itemId: `partial-${running.turn.id}`,
          delta: event.delta.text,
        });
      }
      return;
    }
    if (message.type === "result") {
      if (message.session_id !== running.session.id || typeof message.is_error !== "boolean") {
        this.#fail(running, "Claude returned an invalid terminal result");
        return;
      }
      running.result = message;
      this.#endInput(running);
    }
  }
  #endInput(running: Running): void {
    if (
      running.result === undefined ||
      running.state !== "idle" ||
      running.requests.size > 0 ||
      running.inputEnded
    )
      return;
    running.inputEnded = true;
    running.child.stdin.end();
  }
  #item(running: Running, item: Item): void {
    const index = running.turn.items.findIndex((entry) => entry.id === item.id);
    if (index === -1) running.turn.items.push(item);
    else running.turn.items[index] = item;
    this.#emit("item/completed", running, { item });
  }
  #emit(method: string, running: Running, params: Record<string, unknown>): void {
    const message = {
      method,
      params: { threadId: running.session.id, turnId: running.turn.id, ...params },
    };
    for (const handler of this.#handlers) handler(message);
  }
  async #permission(running: Running, id: string, request: Record<string, unknown>): Promise<void> {
    let response: Record<string, unknown> = {
      behavior: "deny",
      message: "This Claude action is not supported by the Slack bridge",
    };
    try {
      if (
        request.subtype !== "can_use_tool" ||
        typeof request.tool_name !== "string" ||
        !record(request.input)
      )
        throw new Error("Unsupported Claude control request");
      const input = request.input;
      const tool = request.tool_name;
      const handler = this.#requestHandler;
      if (handler === undefined) throw new Error("A Claude approval handler is unavailable");
      if (JSON.stringify(input).length > 12_000)
        throw new Error("Complete this large Claude request locally");
      const params: Record<string, unknown> = {
        threadId: running.session.id,
        turnId: running.turn.id,
        itemId: request.tool_use_id ?? id,
        reason: JSON.stringify({ tool, input }),
        availableDecisions: ["accept", "decline"],
      };
      let method: string;
      let questions: Record<string, unknown>[] = [];
      if (tool === "Bash" && typeof input.command === "string" && input.command.trim()) {
        method = "item/commandExecution/requestApproval";
        params.command = input.command;
        params.cwd = running.session.cwd;
      } else if (["Edit", "Write", "NotebookEdit"].includes(tool)) {
        const target = input.file_path ?? input.notebook_path;
        if (typeof target !== "string" || !target.trim())
          throw new Error("Claude did not identify the changed file");
        method = "item/fileChange/requestApproval";
        params.paths = [path.resolve(running.session.cwd, target)];
        params.changes = [{ path: path.resolve(running.session.cwd, target), input }];
      } else if (
        tool === "AskUserQuestion" &&
        Array.isArray(input.questions) &&
        input.questions.length > 0 &&
        input.questions.length <= 4
      ) {
        method = "item/tool/requestUserInput";
        questions = input.questions.map((question: unknown, index) => {
          if (
            !record(question) ||
            typeof question.question !== "string" ||
            !Array.isArray(question.options)
          )
            throw new Error("Invalid Claude question");
          return { ...question, id: `question-${index + 1}`, isOther: true, isSecret: false };
        });
        params.questions = questions;
      } else throw new Error("This Claude tool requires local approval");
      const answer = await handler({ id, method, params });
      if (!record(answer)) throw new Error("Claude approval response is invalid");
      if (method === "item/tool/requestUserInput" && record(answer.answers)) {
        const answers: Record<string, unknown> = {};
        for (const question of questions) {
          const entry = answer.answers[String(question.id)];
          if (
            !record(entry) ||
            !Array.isArray(entry.answers) ||
            !entry.answers.every((value) => typeof value === "string") ||
            entry.answers.length === 0
          )
            throw new Error("Claude question was not answered");
          answers[String(question.question)] = entry.answers.join(", ");
        }
        response = { behavior: "allow", updatedInput: { ...input, answers } };
      } else if (answer.decision === "accept")
        response = { behavior: "allow", updatedInput: input };
      else response = { behavior: "deny", message: "The user declined this Claude action" };
    } catch (error) {
      response = { behavior: "deny", message: errorText(error) };
    }
    if (
      !running.requests.delete(id) ||
      this.#running.get(running.session.id) !== running ||
      running.failed ||
      running.inputEnded
    )
      return;
    try {
      this.#send(running, {
        type: "control_response",
        response: { subtype: "success", request_id: id, response },
      });
      this.#emit("serverRequest/resolved", running, { requestId: id });
      this.#endInput(running);
    } catch {
      this.#fail(running, "Claude permission response could not be delivered");
    }
  }
  #cancelRequests(running: Running): void {
    for (const id of running.requests)
      this.#emit("serverRequest/resolved", running, { requestId: id });
    running.requests.clear();
  }
  #fail(running: Running, message: string): void {
    if (running.failed) return;
    running.failed = true;
    this.#cancelRequests(running);
    for (const pending of running.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    running.controls.clear();
    this.#emit("thread/status/changed", running, { status: { type: "systemError" } });
    this.#emit("error", running, { error: { message } });
    running.child.kill("SIGTERM");
  }
  async #finished(
    running: Running,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    this.#cancelRequests(running);
    for (const pending of running.controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Claude process exited before responding"));
    }
    running.controls.clear();
    running.reader.close();
    if (this.#running.get(running.session.id) === running) this.#running.delete(running.session.id);
    const result = running.result;
    if (
      !running.failed &&
      result !== undefined &&
      signal === null &&
      (code === 0 || result.is_error === true)
    ) {
      running.session.initialized = true;
      if (running.interruptAcknowledged) {
        running.turn.status = "interrupted";
        running.turn.error = { message: "Claude turn was interrupted" };
      } else if (result.is_error === true) {
        running.turn.status = "failed";
        let message = "Claude stopped before completing this request";
        if (
          Array.isArray(result.errors) &&
          result.errors.every((entry) => typeof entry === "string") &&
          result.errors.length > 0
        )
          message = result.errors.join("; ");
        else if (typeof result.result === "string" && result.result.trim()) message = result.result;
        running.turn.error = { message };
      } else {
        running.turn.status = "completed";
        if (typeof result.result === "string")
          this.#item(running, {
            id: `final-${running.turn.id}`,
            type: "agentMessage",
            phase: "final_answer",
            text: result.result,
          });
      }
      await this.#save(running.session);
      this.#emit("turn/completed", running, { turn: structuredClone(running.turn) });
      return;
    }
    if (running.promptSent) {
      await this.#save(running.session);
      this.#emit("thread/status/changed", running, { status: { type: "systemError" } });
      this.#emit("turn/uncertain", running, {
        error: {
          message: `Claude stopped without confirmed terminal evidence. Inspect locally with claude --resume ${running.session.id} before continuing.`,
        },
      });
    }
  }
  async #terminate(running: Running): Promise<void> {
    this.#cancelRequests(running);
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      await running.closed;
      return;
    }
    running.child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      running.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (running.child.exitCode === null && running.child.signalCode === null)
      running.child.kill("SIGKILL");
    await running.closed;
  }
}
