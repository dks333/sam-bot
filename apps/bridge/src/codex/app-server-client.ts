import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

import { codexChildEnvironment } from "../runtime/child-environment.js";
import { observeNativeStartup, type NativeStartupEvent } from "./startup-observation.js";

export type AppServerMessageHandler = (message: unknown) => void;
export interface AppServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}
export type AppServerRequestHandler = (request: AppServerRequest) => Promise<unknown>;

export interface AppServerRuntimeInfo {
  initializationObserved: boolean;
  platformFamily?: string;
  platformOs?: string;
  userAgent?: string;
}

export interface AppServerConnection {
  close(): Promise<void>;
  notify(method: string, params?: unknown): void;
  request(method: string, params?: unknown): Promise<unknown>;
  subscribe(handler: AppServerMessageHandler): () => void;
  subscribeRequests?(handler: AppServerRequestHandler): () => void;
  runtimeInfo?(): AppServerRuntimeInfo;
}

export interface ProcessAppServerConnectionOptions {
  codexHome?: string;
  executablePath?: string;
  onStderr?: (message: string) => void;
  onStartup?: (event: NativeStartupEvent) => void;
  signal?: AbortSignal;
}

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class AppServerResponseError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "AppServerResponseError";
    this.code = code;
    this.data = data;
  }
}

function responseError(value: unknown): Error {
  if (!isRecord(value)) {
    return new Error("Codex app-server returned an unknown JSON-RPC error");
  }
  const message = value.message;
  return new AppServerResponseError(
    typeof message === "string" ? message : "Codex app-server request failed",
    typeof value.code === "number" ? value.code : undefined,
    value.data,
  );
}

function codexEntrypoint(): string {
  return createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
}

export function appServerInitializeParams(): Record<string, unknown> {
  return {
    capabilities: { experimentalApi: true },
    clientInfo: {
      name: "sam-bot",
      title: "Sam Bot",
      version: "0.1.0",
    },
  };
}

export class ProcessAppServerConnection implements AppServerConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #handlers = new Set<AppServerMessageHandler>();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #reader: readline.Interface;
  #requestHandler: AppServerRequestHandler | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #nextRequestId = 1;
  #runtimeInfo: AppServerRuntimeInfo = { initializationObserved: false };

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: ProcessAppServerConnectionOptions,
  ) {
    this.#child = child;
    this.#reader = readline.createInterface({ input: child.stdout });
    this.#reader.on("line", (line) => {
      this.#handleLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message.length > 0) {
        options.onStderr?.(message);
      }
    });
    child.stdin.on("error", (error) => {
      this.#fail(error);
    });
    child.once("error", (error) => {
      this.#fail(error);
    });
    child.once("exit", (code, signal) => {
      if (this.#closed) {
        return;
      }
      const detail = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      this.#fail(new Error(`Codex app-server stopped with ${detail}`));
    });
  }

  static async create(
    options: ProcessAppServerConnectionOptions = {},
  ): Promise<ProcessAppServerConnection> {
    options.signal?.throwIfAborted();
    const launchingBegan = performance.now();
    observeNativeStartup(options.onStartup, "process-launch", "starting", launchingBegan);
    let child: ChildProcessWithoutNullStreams;
    try {
      const environment = codexChildEnvironment();
      environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "slack_codex_local";
      if (options.codexHome !== undefined) {
        environment.CODEX_HOME = options.codexHome;
      }
      let program = process.execPath;
      const arguments_: string[] = [];
      if (options.executablePath === undefined) {
        arguments_.push(codexEntrypoint());
      } else {
        if (!path.isAbsolute(options.executablePath) || /\p{Cc}/u.test(options.executablePath)) {
          throw new Error("The native Codex executable must be an absolute path");
        }
        program = options.executablePath;
      }
      arguments_.push("app-server");
      child = spawn(program, arguments_, {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      observeNativeStartup(options.onStartup, "process-launch", "failed", launchingBegan);
      throw error;
    }
    const connection = new ProcessAppServerConnection(child, options);
    observeNativeStartup(options.onStartup, "process-launch", "completed", launchingBegan);
    let cancelledClose: Promise<void> | undefined;
    try {
      options.signal?.throwIfAborted();
      const onAbort = () => {
        cancelledClose = connection.close();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let initialized: unknown;
      const initializeBegan = performance.now();
      observeNativeStartup(options.onStartup, "initialize-rpc", "starting", initializeBegan);
      try {
        initialized = await connection.request("initialize", appServerInitializeParams());
        options.signal?.throwIfAborted();
        observeNativeStartup(options.onStartup, "initialize-rpc", "completed", initializeBegan);
      } catch (error) {
        observeNativeStartup(options.onStartup, "initialize-rpc", "failed", initializeBegan);
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
      }
      if (isRecord(initialized)) {
        connection.#runtimeInfo = {
          initializationObserved: true,
          ...(typeof initialized.platformFamily === "string"
            ? { platformFamily: initialized.platformFamily }
            : {}),
          ...(typeof initialized.platformOs === "string"
            ? { platformOs: initialized.platformOs }
            : {}),
          ...(typeof initialized.userAgent === "string"
            ? { userAgent: initialized.userAgent }
            : {}),
        };
      }
      connection.notify("initialized");
      return connection;
    } catch (error) {
      await (cancelledClose ?? connection.close());
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#reader.close();
    this.#rejectPending(new Error("Codex app-server connection closed"));
    this.#closing = this.#terminateChild().finally(() => {
      this.#child.stdin.destroy();
      this.#child.stdout.destroy();
      this.#child.stderr.destroy();
    });
    return this.#closing;
  }

  async #terminateChild(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.#child.once("exit", () => {
        resolve();
      });
    });
    this.#child.kill("SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 5_000);
      timeout.unref();
    });
    await Promise.race([exited, timedOut]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      let killTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            killTimeout = setTimeout(
              () => reject(new Error("Native process termination was not confirmed")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (killTimeout !== undefined) clearTimeout(killTimeout);
      }
    }
  }

  notify(method: string, params?: unknown): void {
    this.#send({ method, ...(params === undefined ? {} : { params }) });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Codex app-server connection is closed"));
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      try {
        this.#send({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  subscribe(handler: AppServerMessageHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  subscribeRequests(handler: AppServerRequestHandler): () => void {
    if (this.#requestHandler !== undefined) {
      throw new Error("Codex app-server already has a request handler");
    }
    this.#requestHandler = handler;
    return () => {
      if (this.#requestHandler === handler) {
        this.#requestHandler = undefined;
      }
    };
  }

  runtimeInfo(): AppServerRuntimeInfo {
    return { ...this.#runtimeInfo };
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.close();
    this.#rejectPending(error);
    for (const handler of this.#handlers) {
      handler({
        method: "transport/closed",
        params: { message: error.message },
      });
    }
    void this.close().catch(() => undefined);
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    const id = message.id;
    if (typeof id === "number" && message.method === undefined) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        if (Object.hasOwn(message, "error")) {
          pending.reject(responseError(message.error));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }
    if ((typeof id === "number" || typeof id === "string") && typeof message.method === "string") {
      if (this.#requestHandler !== undefined) {
        void this.#requestHandler({ id, method: message.method, params: message.params })
          .then((result) => {
            if (!this.#closed) {
              this.#send({ id, result });
            }
          })
          .catch(() => {
            if (!this.#closed) {
              this.#send({
                id,
                error: { code: -32_603, message: "Codex user interaction could not be completed" },
              });
            }
          });
        return;
      }
      this.#send({
        id,
        error: { code: -32_601, message: "A native interaction handler is not registered" },
      });
      return;
    }
    for (const handler of this.#handlers) {
      handler(message);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(message: Record<string, unknown>): void {
    if (this.#closed) {
      throw new Error("Codex app-server connection is closed");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
