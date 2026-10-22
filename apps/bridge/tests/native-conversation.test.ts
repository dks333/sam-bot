import { describe, expect, it, vi } from "vitest";

import type {
  AppServerConnection,
  AppServerMessageHandler,
  AppServerRequest,
  AppServerRequestHandler,
} from "../src/codex/app-server-client.js";
import { NativeConversation } from "../src/codex/native-conversation.js";
import { isUnadmittedNativeSteer } from "../src/codex/native-conversation.js";
import { AppServerResponseError } from "../src/codex/app-server-client.js";

function setup(developerInstructions?: string) {
  const handlers = new Set<AppServerMessageHandler>();
  let requestHandler: AppServerRequestHandler | undefined;
  const responses: unknown[] = [];
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (responses.length > 0) return responses.shift();
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: "thread-one" } };
    if (method === "turn/start") return { turn: { id: "turn-one" } };
    if (method === "turn/steer") return { turnId: "turn-one" };
    return {};
  });
  const close = vi.fn(async () => {});
  const connection: AppServerConnection = {
    request,
    close,
    notify: () => {},
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    subscribeRequests: (handler) => {
      requestHandler = handler;
      return () => {
        requestHandler = undefined;
      };
    },
  };
  const factory = vi.fn(async () => connection);
  const conversation = new NativeConversation({
    connectionFactory: factory,
    ...(developerInstructions === undefined ? {} : { developerInstructions }),
  });
  return {
    connection,
    conversation,
    factory,
    close,
    request,
    responses,
    emit(message: unknown) {
      for (const handler of handlers) handler(message);
    },
    async serverRequest(value: AppServerRequest): Promise<unknown> {
      if (requestHandler === undefined) throw new Error("No synthetic native request handler");
      return requestHandler(value);
    },
  };
}

describe("native conversation transport", () => {
  it("correlates native input with the original client message and validates steering admission", async () => {
    const harness = setup();
    await harness.conversation.startTurn("thread-one", "Investigate", undefined, "synthetic-root");
    await harness.conversation.steer(
      "thread-one",
      "turn-one",
      "Check another case",
      "synthetic-followup",
    );
    expect(harness.request.mock.calls).toEqual([
      [
        "turn/start",
        {
          threadId: "thread-one",
          input: [{ type: "text", text: "Investigate", text_elements: [] }],
          clientUserMessageId: "synthetic-root",
        },
      ],
      [
        "turn/steer",
        {
          threadId: "thread-one",
          expectedTurnId: "turn-one",
          input: [{ type: "text", text: "Check another case", text_elements: [] }],
          clientUserMessageId: "synthetic-followup",
        },
      ],
    ]);
    harness.responses.push({ turnId: "other-turn" });
    await expect(harness.conversation.steer("thread-one", "turn-one", "Continue")).rejects.toThrow(
      "expected steering turn",
    );
    await harness.conversation.close();
  });

  it("only identifies proven native steering refusals as unadmitted", () => {
    expect(
      isUnadmittedNativeSteer(new AppServerResponseError("no active turn to steer", -32600)),
    ).toBe(true);
    expect(
      isUnadmittedNativeSteer(
        new AppServerResponseError("cannot steer a review turn", -32600, {
          codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } },
        }),
      ),
    ).toBe(true);
    expect(isUnadmittedNativeSteer(new Error("no active turn to steer"))).toBe(false);
    expect(isUnadmittedNativeSteer(new AppServerResponseError("Transport closed", -32000))).toBe(
      false,
    );
  });

  it("reconciles the exact turn through bounded native history pages", async () => {
    const harness = setup();
    const turn = { id: "older-turn", status: "completed", items: [] };
    harness.responses.push(
      { data: [{ id: "newer-turn" }], nextCursor: "next-page" },
      { data: [turn], nextCursor: null },
    );
    expect(await harness.conversation.readTurn("thread-one", "older-turn")).toEqual(turn);
    expect(harness.request.mock.calls).toEqual([
      ["thread/turns/list", { threadId: "thread-one", limit: 100, itemsView: "full" }],
      [
        "thread/turns/list",
        { threadId: "thread-one", limit: 100, itemsView: "full", cursor: "next-page" },
      ],
    ]);
    await harness.conversation.close();
  });

  it("bounds stalled native history reconciliation without dispatching a turn", async () => {
    vi.useFakeTimers();
    const harness = setup();
    harness.request.mockImplementationOnce(async () => new Promise(() => {}));
    const read = harness.conversation.readTurn("thread-one", "turn-one");
    const rejected = expect(read).rejects.toThrow("time budget");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(harness.request.mock.calls.map(([method]) => method)).toEqual(["thread/turns/list"]);
    await harness.conversation.close();
    vi.useRealTimers();
  });

  it("initializes one shared connection without requesting model or tool overrides", async () => {
    const harness = setup();
    await Promise.all([harness.conversation.start(), harness.conversation.start()]);
    expect(harness.factory).toHaveBeenCalledTimes(1);
    expect(harness.request).not.toHaveBeenCalled();
    await harness.conversation.close();
  });

  it("starts and resumes persistent threads with only the selected native directory", async () => {
    const harness = setup();
    expect(await harness.conversation.startThread("/synthetic/project")).toBe("thread-one");
    await harness.conversation.resumeThread("thread-one", "/synthetic/project");
    expect(harness.request.mock.calls).toEqual([
      ["thread/start", { cwd: "/synthetic/project" }],
      ["thread/resume", { threadId: "thread-one", cwd: "/synthetic/project" }],
    ]);
    await harness.conversation.close();
  });

  it("applies an optional native persona only when starting and resuming a thread", async () => {
    const developerInstructions = "You are the owner's Slack bot. Keep identity replies casual.";
    const harness = setup(developerInstructions);
    await harness.conversation.startThread("/synthetic/project");
    await harness.conversation.resumeThread("thread-one", "/synthetic/project");
    await harness.conversation.startTurn("thread-one", "Who r u???");
    await harness.conversation.steer("thread-one", "turn-one", "Explain your capabilities");
    expect(harness.request.mock.calls).toEqual([
      ["thread/start", { cwd: "/synthetic/project", developerInstructions }],
      [
        "thread/resume",
        { threadId: "thread-one", cwd: "/synthetic/project", developerInstructions },
      ],
      [
        "thread/inject_items",
        {
          threadId: "thread-one",
          items: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: developerInstructions }],
            },
          ],
        },
      ],
      [
        "turn/start",
        {
          threadId: "thread-one",
          input: [{ type: "text", text: "Who r u???", text_elements: [] }],
        },
      ],
      [
        "turn/steer",
        {
          threadId: "thread-one",
          expectedTurnId: "turn-one",
          input: [{ type: "text", text: "Explain your capabilities", text_elements: [] }],
        },
      ],
    ]);
    await harness.conversation.close();
  });

  it("does not confirm a persona resume before native context injection succeeds", async () => {
    const harness = setup("You are the owner's Slack bot.");
    const failed = new Error("Synthetic native context injection failed");
    harness.request.mockImplementationOnce(async () => ({ thread: { id: "thread-one" } }));
    harness.request.mockRejectedValueOnce(failed);
    await expect(
      harness.conversation.resumeThread("thread-one", "/synthetic/project"),
    ).rejects.toBe(failed);
    expect(harness.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "thread/inject_items",
    ]);
    await harness.conversation.close();
  });

  it("sends the exact user text and local images with no profile or policy additions", async () => {
    const harness = setup();
    const text = "  Why???\n\nPlease investigate this.  ";
    expect(await harness.conversation.startTurn("thread-one", text, ["/synthetic/image.png"])).toBe(
      "turn-one",
    );
    expect(harness.request.mock.calls).toEqual([
      [
        "turn/start",
        {
          threadId: "thread-one",
          input: [
            { type: "text", text, text_elements: [] },
            { type: "localImage", path: "/synthetic/image.png" },
          ],
        },
      ],
    ]);
    await harness.conversation.close();
  });

  it("installs event subscriptions before a turn can emit notifications", async () => {
    const harness = setup();
    const event = {
      method: "turn/started",
      params: { threadId: "thread-one", turn: { id: "turn-one" } },
    };
    const events: unknown[] = [];
    harness.conversation.subscribe((message) => events.push(message));
    harness.request.mockImplementationOnce(async () => {
      harness.emit(event);
      expect(events).toEqual([event]);
      return { turn: { id: "turn-one" } };
    });
    await harness.conversation.startTurn("thread-one", "Investigate");
    expect(events[0]).toBe(event);
    await harness.conversation.close();
  });

  it.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "item/tool/call",
    "currentTime/read",
  ])("forwards the native %s request and response without changing either", async (method) => {
    const harness = setup();
    const response = { nativeDecision: "synthetic-owner-result" };
    const handler = vi.fn(async () => response);
    harness.conversation.subscribeRequests(handler);
    await harness.conversation.start();
    const request = {
      id: "request-one",
      method,
      params: { threadId: "thread-one", opaque: "preserved" },
    };
    expect(await harness.serverRequest(request)).toBe(response);
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);
    await harness.conversation.close();
  });

  it("steers and interrupts only the explicitly supplied native turn", async () => {
    const harness = setup();
    await harness.conversation.steer("thread-one", "turn-one", "Keep investigating");
    await harness.conversation.interrupt("thread-one", "turn-one");
    expect(harness.request.mock.calls).toEqual([
      [
        "turn/steer",
        {
          threadId: "thread-one",
          expectedTurnId: "turn-one",
          input: [{ type: "text", text: "Keep investigating", text_elements: [] }],
        },
      ],
      ["turn/interrupt", { threadId: "thread-one", turnId: "turn-one" }],
    ]);
    await harness.conversation.close();
  });

  it("returns native history without synthesizing conversation context", async () => {
    const harness = setup();
    const history = { thread: { id: "thread-one", turns: [{ id: "turn-one", items: [] }] } };
    harness.responses.push(history);
    expect(await harness.conversation.readThread("thread-one")).toBe(history);
    expect(harness.request).toHaveBeenCalledExactlyOnceWith("thread/read", {
      threadId: "thread-one",
      includeTurns: true,
    });
    await harness.conversation.close();
  });

  it("unsubscribes handlers and closes the connection once", async () => {
    const harness = setup();
    const onMessage = vi.fn();
    const unsubscribe = harness.conversation.subscribe(onMessage);
    await harness.conversation.start();
    unsubscribe();
    harness.emit({ method: "synthetic/event" });
    expect(onMessage).not.toHaveBeenCalled();
    await Promise.all([harness.conversation.close(), harness.conversation.close()]);
    expect(harness.close).toHaveBeenCalledTimes(1);
    await expect(harness.conversation.startTurn("thread-one", "Do not dispatch")).rejects.toThrow(
      "closed",
    );
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("closes a late initialized connection rather than using it after shutdown", async () => {
    const harness = setup();
    let finish: (connection: AppServerConnection) => void = () => {};
    const initializing = new Promise<AppServerConnection>((resolve) => {
      finish = resolve;
    });
    const factory = vi.fn(async () => initializing);
    const conversation = new NativeConversation({ connectionFactory: factory });
    const starting = conversation.startTurn("thread-one", "Do not dispatch after shutdown");
    const rejected = expect(starting).rejects.toThrow("closed during initialization");
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    const closing = conversation.close();
    finish(harness.connection);
    await Promise.all([rejected, closing]);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("does not adopt a transport that cannot forward native interaction requests", async () => {
    const close = vi.fn(async () => {});
    const connection: AppServerConnection = {
      close,
      request: vi.fn(async () => ({})),
      notify: () => {},
      subscribe: () => () => {},
    };
    const conversation = new NativeConversation({ connectionFactory: async () => connection });
    await expect(conversation.start()).rejects.toThrow("cannot forward interaction requests");
    expect(close).toHaveBeenCalledTimes(1);
    await conversation.close();
  });

  it.each([{}, { thread: {} }, { thread: { id: "" } }, { thread: { id: "bad\nidentity" } }])(
    "rejects native thread responses without a valid identity",
    async (response) => {
      const harness = setup();
      harness.responses.push(response);
      await expect(harness.conversation.startThread("/synthetic/project")).rejects.toThrow(
        /identify|identity/u,
      );
      await harness.conversation.close();
    },
  );

  it("rejects a resume response for a different native thread", async () => {
    const harness = setup();
    harness.responses.push({ thread: { id: "other-thread" } });
    await expect(
      harness.conversation.resumeThread("thread-one", "/synthetic/project"),
    ).rejects.toThrow("different thread");
    await harness.conversation.close();
  });

  it("does not create a connection for invalid paths, identities or empty input", async () => {
    const harness = setup();
    await expect(harness.conversation.startThread("relative/project")).rejects.toThrow("absolute");
    await expect(harness.conversation.startTurn("", "Request")).rejects.toThrow("identity");
    await expect(harness.conversation.startTurn("thread-one", " ")).rejects.toThrow(
      "requires user",
    );
    await expect(
      harness.conversation.startTurn("thread-one", "Request", ["relative.png"]),
    ).rejects.toThrow("absolute");
    expect(harness.factory).not.toHaveBeenCalled();
    await harness.conversation.close();
  });
});
