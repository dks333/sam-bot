import type {
  AppServerMessageHandler,
  AppServerRequestHandler,
} from "../codex/app-server-client.js";

export class ConversationSteerUnavailableError extends Error {
  constructor() {
    super("This agent queues follow-up instructions until its current turn completes.");
    this.name = "ConversationSteerUnavailableError";
  }
}

export class ConversationDispatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationDispatchRejectedError";
  }
}

export interface ConversationBackend {
  start(): Promise<void>;
  startThread(cwd: string): Promise<string>;
  resumeThread(threadId: string, cwd: string): Promise<void>;
  validateTurn?(text: string, imagePaths?: string[]): Promise<void>;
  startTurn(
    threadId: string,
    text: string,
    imagePaths?: string[],
    clientUserMessageId?: string,
  ): Promise<string>;
  steer(
    threadId: string,
    turnId: string,
    text: string,
    clientUserMessageId?: string,
  ): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  readThread(threadId: string): Promise<unknown>;
  readTurn(threadId: string, turnId: string): Promise<Record<string, unknown> | undefined>;
  subscribe(handler: AppServerMessageHandler): () => void;
  subscribeRequests(handler: AppServerRequestHandler): () => void;
  close(): Promise<void>;
}
