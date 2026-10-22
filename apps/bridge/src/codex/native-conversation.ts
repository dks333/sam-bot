import path from "node:path";

import type {
  AppServerConnection,
  AppServerMessageHandler,
  AppServerRequestHandler,
} from "./app-server-client.js";
import { AppServerResponseError } from "./app-server-client.js";

export function isUnadmittedNativeSteer(error: unknown): boolean {
  if (!(error instanceof AppServerResponseError) || error.code !== -32600) return false;
  if (error.message === "no active turn to steer") return true;
  if (/^expected active turn id `[^`]+` but found `[^`]+`$/u.test(error.message)) return true;
  return (
    isRecord(error.data) &&
    isRecord(error.data.codexErrorInfo) &&
    isRecord(error.data.codexErrorInfo.activeTurnNotSteerable) &&
    ["review", "compact"].includes(
      String(error.data.codexErrorInfo.activeTurnNotSteerable.turnKind),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`The native ${label} identity is invalid`);
  }
  return value;
}

function responseIdentity(value: unknown, key: string): string {
  if (!isRecord(value) || !isRecord(value[key])) {
    throw new Error(`The native response did not identify its ${key}`);
  }
  return identity(value[key].id, key);
}

function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || /\p{Cc}/u.test(value)) {
    throw new Error("Native conversation paths must be absolute");
  }
  return value;
}

function userInput(text: string, imagePaths: readonly string[] = []): Record<string, unknown>[] {
  if (text.trim().length === 0 && imagePaths.length === 0) {
    throw new Error("A native turn requires user text or an image");
  }
  return [
    { type: "text", text, text_elements: [] },
    ...imagePaths.map((imagePath) => ({ type: "localImage", path: absolutePath(imagePath) })),
  ];
}

export class NativeConversation {
  readonly #connectionFactory: () => Promise<AppServerConnection>;
  readonly #developerInstructions: string | undefined;
  readonly #handlers = new Set<AppServerMessageHandler>();
  #requestHandler: AppServerRequestHandler | undefined;
  #connection: AppServerConnection | undefined;
  #connectionPromise: Promise<AppServerConnection> | undefined;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeRequests: (() => void) | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: {
    connectionFactory: () => Promise<AppServerConnection>;
    developerInstructions?: string;
  }) {
    this.#connectionFactory = options.connectionFactory;
    this.#developerInstructions = options.developerInstructions;
  }

  async start(): Promise<void> {
    await this.#connect();
  }

  async startThread(cwd: string): Promise<string> {
    const params = {
      cwd: absolutePath(cwd),
      ...(this.#developerInstructions === undefined
        ? {}
        : { developerInstructions: this.#developerInstructions }),
    };
    const response = await this.#request("thread/start", params);
    return responseIdentity(response, "thread");
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    const params = {
      threadId: identity(threadId, "thread"),
      cwd: absolutePath(cwd),
      ...(this.#developerInstructions === undefined
        ? {}
        : { developerInstructions: this.#developerInstructions }),
    };
    const response = await this.#request("thread/resume", params);
    if (responseIdentity(response, "thread") !== threadId) {
      throw new Error("The native response resumed a different thread");
    }
    if (this.#developerInstructions !== undefined) {
      await this.#request("thread/inject_items", {
        threadId,
        items: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: this.#developerInstructions }],
          },
        ],
      });
    }
  }

  async startTurn(
    threadId: string,
    text: string,
    imagePaths?: string[],
    clientUserMessageId?: string,
  ): Promise<string> {
    const params = {
      threadId: identity(threadId, "thread"),
      input: userInput(text, imagePaths),
      ...(clientUserMessageId === undefined
        ? {}
        : { clientUserMessageId: identity(clientUserMessageId, "client message") }),
    };
    const response = await this.#request("turn/start", params);
    return responseIdentity(response, "turn");
  }

  async steer(
    threadId: string,
    turnId: string,
    text: string,
    clientUserMessageId?: string,
  ): Promise<void> {
    const params = {
      threadId: identity(threadId, "thread"),
      expectedTurnId: identity(turnId, "turn"),
      input: userInput(text),
      ...(clientUserMessageId === undefined
        ? {}
        : { clientUserMessageId: identity(clientUserMessageId, "client message") }),
    };
    const response = await this.#request("turn/steer", params);
    if (!isRecord(response) || response.turnId !== turnId)
      throw new Error("Codex did not confirm the expected steering turn");
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const params = { threadId: identity(threadId, "thread"), turnId: identity(turnId, "turn") };
    await this.#request("turn/interrupt", params);
  }

  async readThread(threadId: string): Promise<unknown> {
    const params = { threadId: identity(threadId, "thread"), includeTurns: true };
    return this.#request("thread/read", params);
  }

  async readTurn(threadId: string, turnId: string): Promise<Record<string, unknown> | undefined> {
    identity(turnId, "turn");
    let cursor: string | undefined;
    const deadline = Date.now() + 10_000;
    for (let page = 0; page < 5; page += 1) {
      const response = await this.#requestWithin(
        "thread/turns/list",
        {
          threadId: identity(threadId, "thread"),
          limit: 100,
          itemsView: "full",
          ...(cursor === undefined ? {} : { cursor }),
        },
        deadline,
      );
      if (!isRecord(response) || !Array.isArray(response.data))
        throw new Error("Codex did not return a native history page");
      for (const turn of response.data) {
        if (isRecord(turn) && turn.id === turnId) return turn;
      }
      if (response.nextCursor === null) return undefined;
      if (typeof response.nextCursor !== "string" || response.nextCursor === cursor)
        throw new Error("Codex returned an invalid native history cursor");
      cursor = response.nextCursor;
    }
    return undefined;
  }

  subscribe(handler: AppServerMessageHandler): () => void {
    this.#assertOpen();
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  subscribeRequests(handler: AppServerRequestHandler): () => void {
    this.#assertOpen();
    if (this.#requestHandler !== undefined) {
      throw new Error("A native conversation interaction handler is already registered");
    }
    this.#requestHandler = handler;
    return () => {
      if (this.#requestHandler === handler) this.#requestHandler = undefined;
    };
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribeRequests?.();
    this.#handlers.clear();
    this.#requestHandler = undefined;
    this.#closing = this.#closeConnection();
    return this.#closing;
  }

  async #closeConnection(): Promise<void> {
    if (this.#connection !== undefined) {
      await this.#connection.close();
      return;
    }
    await this.#connectionPromise?.catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The native conversation is closed");
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const connection = await this.#connect();
    this.#assertOpen();
    return connection.request(method, params);
  }

  async #requestWithin(method: string, params: unknown, deadline: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#request(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native history reconciliation exceeded its time budget")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #connect(): Promise<AppServerConnection> {
    this.#assertOpen();
    if (this.#connection !== undefined) return this.#connection;
    if (this.#connectionPromise === undefined) {
      this.#connectionPromise = Promise.resolve()
        .then(() => {
          this.#assertOpen();
          return this.#connectionFactory();
        })
        .then(async (connection) => {
          if (this.#closed) {
            await connection.close();
            throw new Error("The native conversation closed during initialization");
          }
          try {
            if (connection.subscribeRequests === undefined) {
              throw new Error("The native transport cannot forward interaction requests");
            }
            this.#unsubscribe = connection.subscribe((message) => {
              for (const handler of this.#handlers) handler(message);
            });
            this.#unsubscribeRequests = connection.subscribeRequests(async (request) => {
              this.#assertOpen();
              const handler = this.#requestHandler;
              if (handler === undefined) {
                throw new Error("A native conversation interaction handler is not registered");
              }
              return handler(request);
            });
            this.#connection = connection;
            return connection;
          } catch (error) {
            this.#unsubscribe?.();
            this.#unsubscribeRequests?.();
            await connection.close();
            throw error;
          }
        })
        .catch((error: unknown) => {
          this.#connectionPromise = undefined;
          throw error;
        });
    }
    const connection = await this.#connectionPromise;
    this.#assertOpen();
    return connection;
  }
}
