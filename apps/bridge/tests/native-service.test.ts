import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeSlackService } from "../src/bridge/native-service.js";
import {
  ConversationDispatchRejectedError,
  ConversationSteerUnavailableError,
} from "../src/agents/conversation-backend.js";
import type { NativeActivitySnapshot } from "../src/bridge/native-activity.js";
import { AppServerResponseError } from "../src/codex/app-server-client.js";
import type { HandleMentionInput } from "../src/bridge/slack-service-contract.js";
import type {
  AppServerConnection,
  AppServerMessageHandler,
  AppServerRequestHandler,
} from "../src/codex/app-server-client.js";
import { NativeConversation } from "../src/codex/native-conversation.js";
import { NativeConversationStore } from "../src/persistence/native-conversation-store.js";
import type { SlackResponder } from "../src/slack/responder.js";
import type { NativeSlackTransport } from "../src/slack/native-transport.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-service-synthetic-"));
  const store = new NativeConversationStore(path.join(directory, "transport.sqlite"));
  const handlers = new Set<AppServerMessageHandler>();
  let requestHandler: AppServerRequestHandler | undefined;
  let turnCount = 0;
  let receiptCount = 0;
  let owned = true;
  let messageSequence = 0;
  const activities: NativeActivitySnapshot[] = [];
  const emit = (message: unknown) => {
    for (const handler of handlers) handler(message);
  };
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: "native-thread" } };
    if (method === "turn/start") {
      turnCount += 1;
      const turnId = `native-turn-${turnCount}`;
      emit({ method: "turn/started", params: { threadId: "native-thread", turn: { id: turnId } } });
      return { turn: { id: turnId } };
    }
    if (method === "turn/steer") return { turnId: `native-turn-${turnCount}` };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    return { params };
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
  const native = new NativeConversation({ connectionFactory: async () => connection });
  const post = vi.fn(async () => {
    receiptCount += 1;
    return `bot-receipt-${receiptCount}`;
  });
  const update = vi.fn(async () => {});
  const reconcile = vi.fn<NativeSlackTransport["reconcile"]>(async () => ({ status: "unknown" }));
  const approval = vi.fn(async (_input: Parameters<NativeSlackTransport["approval"]>[0]) => {});
  const info = vi.fn(async () => {});
  const setMessageStatus = vi.fn<NativeSlackTransport["setMessageStatus"]>(async () => {});
  const responder: SlackResponder = {
    postApproval: async () => {},
    postError: async () => {},
    postInfo: async () => {},
    postPrivateError: async () => {},
    postPrivateInfo: async () => {},
    setMessageStatus: async () => {},
  };
  const service = new NativeSlackService({
    native,
    store,
    cwd: "/synthetic/project",
    transport: {
      post,
      postFinal: post,
      reconcile,
      update,
      approval,
      info,
      privateInfo: info,
      setMessageStatus,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onActivity: (snapshot) => activities.push(snapshot),
    assertOwned: () => {
      if (!owned) throw new Error("Synthetic runtime ownership lost");
    },
  });
  cleanups.push(async () => {
    owned = true;
    await service.shutdown();
    store.close();
    rmSync(directory, { recursive: true });
  });
  const input = (eventId: string, text: string): HandleMentionInput => {
    messageSequence += 1;
    return {
      command: { type: "prompt", prompt: text },
      eventId,
      responder,
      identity: { teamId: "T1", userId: "U1", channelId: "D1" },
      slackMessageTs: `100.${String(messageSequence).padStart(6, "0")}`,
      slackThreadTs: "thread-root",
    };
  };
  return {
    store,
    service,
    request,
    close,
    emit,
    post,
    reconcile,
    update,
    approval,
    info,
    setMessageStatus,
    activities,
    input,
    setOwned(value: boolean) {
      owned = value;
    },
    async serverRequest(method: string, params: unknown) {
      if (requestHandler === undefined) throw new Error("Native request handler missing");
      return requestHandler({ id: "native-request", method, params });
    },
    finish(text = "Native final answer", turnId = "native-turn-1") {
      emit({
        method: "turn/completed",
        params: {
          threadId: "native-thread",
          turn: {
            id: turnId,
            status: "completed",
            items: [{ id: "final-message", type: "agentMessage", phase: "final_answer", text }],
          },
        },
      });
    },
  };
}

async function waitForTurn(harness: ReturnType<typeof setup>, eventId: string) {
  await vi.waitFor(() => expect(harness.store.getDelivery(eventId)?.state).toBe("running"));
}

describe("thin native Slack service", () => {
  it("starts quietly and projects native waiting and resumed execution without changing the active turn", async () => {
    const harness = setup();
    const handling = harness.service.handleMention(harness.input("quiet", "Investigate"));
    await waitForTurn(harness, "quiet");
    expect(harness.post).not.toHaveBeenCalled();
    const key = harness.store.getDelivery("quiet")?.conversationKey;
    if (key === undefined) throw new Error("Expected synthetic conversation");
    expect(harness.service.isExecuting(key, "native-turn-1")).toBe(true);
    harness.emit({
      method: "thread/status/changed",
      params: {
        threadId: "native-thread",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
      },
    });
    expect(harness.activities.at(-1)?.phase).toBe("waiting");
    expect(harness.service.isExecuting(key, "native-turn-1")).toBe(false);
    harness.emit({
      method: "thread/status/changed",
      params: { threadId: "native-thread", status: { type: "active", activeFlags: [] } },
    });
    expect(harness.activities.at(-1)?.phase).toBe("executing");
    harness.finish();
    await handling;
    expect(harness.activities.at(-1)).toMatchObject({ phase: "idle", finalPendingDelivery: true });
    expect(
      harness.activities.every(
        (entry, index) =>
          index === 0 || entry.revision > (harness.activities[index - 1]?.revision ?? 0),
      ),
    ).toBe(true);
  });

  it("routes a natural tagged answer into the pending native question without another model turn", async () => {
    const harness = setup();
    const handling = harness.service.handleMention(harness.input("question-root", "Investigate"));
    await waitForTurn(harness, "question-root");
    const question = harness.serverRequest("item/tool/requestUserInput", {
      threadId: "native-thread",
      turnId: "native-turn-1",
      questions: [{ id: "target", question: "Which target?", options: null }],
    });
    await vi.waitFor(() => expect(harness.info).toHaveBeenCalled());
    expect(harness.activities.at(-1)).toMatchObject({ phase: "waiting", pendingInputCount: 1 });
    await harness.service.handleMention(harness.input("question-answer", "synthetic target"));
    expect(await question).toEqual({ answers: { target: { answers: ["synthetic target"] } } });
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(
      0,
    );
    expect(harness.store.getDelivery("question-answer")?.rootEventId).toBe("question-root");
    harness.finish();
    await handling;
  });

  it("retains a proven rejected steering instruction and continues the same native conversation after completion", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/steer")
        throw new AppServerResponseError("no active turn to steer", -32600);
      return original?.(method, params);
    });
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("retained", "Also check another target"),
    );
    await vi.waitFor(() => expect(harness.store.listUnadmitted()).toHaveLength(1));
    harness.finish("First result");
    await first;
    await waitForTurn(harness, "retained");
    expect(harness.store.getDelivery("retained")?.nativeTurnId).toBe("native-turn-2");
    expect(harness.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(
      harness.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      harness.request.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1],
    ).toMatchObject({
      clientUserMessageId: "retained",
      input: [{ type: "text", text: "Also check another target", text_elements: [] }],
    });
    harness.finish("Follow-up result", "native-turn-2");
    await followup;
  });

  it("reconciles a lost steering acknowledgement through the exact native client message identity without replay", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/steer") throw new Error("Synthetic acknowledgement lost");
      if (method === "thread/turns/list")
        return {
          data: [
            {
              id: "native-turn-1",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "accepted-followup" }],
            },
          ],
          nextCursor: null,
        };
      return original?.(method, params);
    });
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("accepted-followup", "Check another target"),
    );
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("accepted-followup")?.rootEventId).toBe("root"),
    );
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      1,
    );
    harness.finish();
    await Promise.all([first, followup]);
    expect(harness.store.getDelivery("accepted-followup")?.completionStatus).toBe("completed");
  });

  it("rejects delayed text stop commands and confirms cancellation only after a native terminal event", async () => {
    const harness = setup();
    const handling = harness.service.handleMention({
      ...harness.input("root", "Investigate"),
      slackMessageTs: "200.000001",
    });
    await waitForTurn(harness, "root");
    await harness.service.handleMention({
      ...harness.input("old-stop", "stop"),
      slackMessageTs: "199.999999",
    });
    expect(
      harness.request.mock.calls.filter(([method]) => method === "turn/interrupt"),
    ).toHaveLength(0);
    await harness.service.handleMention({
      ...harness.input("stop", "stop"),
      slackMessageTs: "201.000001",
    });
    expect(harness.request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "native-thread",
      turnId: "native-turn-1",
    });
    expect(harness.store.getDelivery("root")?.completionStatus).toBeUndefined();
    harness.emit({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: "native-turn-1", status: "interrupted", items: [] },
      },
    });
    await handling;
    expect(harness.store.getDelivery("root")?.finalText).toContain("stopped");
  });

  it.each([true, false])(
    "retains a stop before turn acknowledgement and interrupts only that generation, event first: %s",
    async (eventFirst) => {
      const harness = setup();
      const original = harness.request.getMockImplementation();
      const starting = deferred<unknown>();
      let firstStart = true;
      harness.request.mockImplementation(async (method, params) => {
        if (method === "turn/start" && firstStart) {
          firstStart = false;
          return starting.promise;
        }
        return original?.(method, params);
      });
      const first = harness.service.handleMention(harness.input("slow-start", "Investigate"));
      await vi.waitFor(() =>
        expect(harness.store.getDelivery("slow-start")?.state).toBe("dispatching"),
      );
      await harness.service.handleMention(harness.input("stop-before-ack", "stop"));
      expect(harness.store.getDelivery("stop-before-ack")?.finalText).toContain("Stop requested");
      expect(harness.store.getDelivery("slow-start")?.completionStatus).toBeUndefined();
      expect(
        harness.request.mock.calls.filter(([method]) => method === "turn/interrupt"),
      ).toHaveLength(0);
      const started = {
        method: "turn/started",
        params: { threadId: "native-thread", turn: { id: "delayed-turn" } },
      };
      if (eventFirst) {
        harness.emit(started);
        await vi.waitFor(() =>
          expect(harness.request).toHaveBeenCalledWith("turn/interrupt", {
            threadId: "native-thread",
            turnId: "delayed-turn",
          }),
        );
      }
      starting.resolve({ turn: { id: "delayed-turn" } });
      await vi.waitFor(() =>
        expect(harness.request).toHaveBeenCalledWith("turn/interrupt", {
          threadId: "native-thread",
          turnId: "delayed-turn",
        }),
      );
      harness.emit(started);
      harness.emit({
        method: "turn/completed",
        params: {
          threadId: "native-thread",
          turn: { id: "delayed-turn", status: "interrupted", items: [] },
        },
      });
      await first;
      const next = harness.service.handleMention(
        harness.input("next-generation", "Investigate the next request"),
      );
      await waitForTurn(harness, "next-generation");
      expect(harness.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toEqual([
        ["turn/interrupt", { threadId: "native-thread", turnId: "delayed-turn" }],
      ]);
      harness.finish();
      await next;
    },
  );

  it("queues follow-ups for a backend without steering and resumes each request once", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/steer") throw new ConversationSteerUnavailableError();
      return original?.(method, params);
    });
    const first = harness.service.handleMention(harness.input("root", "First request"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(harness.input("followup", "Second request"));
    await vi.waitFor(() => expect(harness.store.listUnadmitted()).toHaveLength(1));
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      1,
    );
    harness.finish("First answer");
    await waitForTurn(harness, "followup");
    expect(
      harness.request.mock.calls.filter(([method]) => method === "thread/resume"),
    ).toHaveLength(1);
    harness.finish("Second answer", "native-turn-2");
    await Promise.all([first, followup]);
    expect(harness.store.getDelivery("root")?.finalText).toBe("First answer");
    expect(harness.store.getDelivery("followup")).toMatchObject({
      completionStatus: "completed",
      finalText: "Second answer",
    });
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      2,
    );
    expect(harness.post).toHaveBeenCalledTimes(2);
  });

  it("settles a crashed agent turn as uncertain and does not replay later instructions", async () => {
    const harness = setup();
    const first = harness.service.handleMention(harness.input("root", "First request"));
    await waitForTurn(harness, "root");
    harness.emit({
      method: "turn/uncertain",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        error: { message: "Synthetic process stopped without terminal evidence" },
      },
    });
    await first;
    expect(harness.store.getDelivery("root")).toMatchObject({
      completionStatus: "uncertain",
      finalText: "Synthetic process stopped without terminal evidence",
    });
    await harness.service.handleMention(harness.input("followup", "Second request"));
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(harness.store.getDelivery("followup")?.completionStatus).toBe("failed");
  });

  it("allows a corrected request after a backend proves the original prompt was never sent", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    let rejected = false;
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/start" && !rejected) {
        rejected = true;
        throw new ConversationDispatchRejectedError(
          "Synthetic local login expired before dispatch",
        );
      }
      return original?.(method, params);
    });
    await harness.service.handleMention(harness.input("rejected", "First request"));
    expect(harness.store.getDelivery("rejected")).toMatchObject({
      completionStatus: "failed",
      finalText: "Synthetic local login expired before dispatch",
    });
    const next = harness.service.handleMention(harness.input("corrected", "Corrected request"));
    await waitForTurn(harness, "corrected");
    harness.finish("Corrected answer");
    await next;
    expect(harness.store.getDelivery("corrected")?.completionStatus).toBe("completed");
  });

  it("cancels retained unadmitted instructions for the exact stopped turn without replaying their text", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/steer")
        throw new AppServerResponseError("no active turn to steer", -32600);
      return original?.(method, params);
    });
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("retained", "Keep this original instruction"),
    );
    await vi.waitFor(() => expect(harness.store.listUnadmitted()).toHaveLength(1));
    await harness.service.handleMention(harness.input("stop-retained", "stop"));
    expect(harness.store.getDelivery("retained")).toMatchObject({
      text: "Keep this original instruction",
      completionStatus: "failed",
      finalText: "This instruction was canceled before native admission.",
    });
    harness.emit({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: "native-turn-1", status: "interrupted", items: [] },
      },
    });
    await Promise.all([first, followup]);
    expect(harness.store.listUnadmitted()).toEqual([]);
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      1,
    );
  });

  it("recovers uncertain execution from exact native turn evidence without dispatching another turn", async () => {
    const harness = setup();
    const delivery = harness.store.claim({
      eventId: "recovery",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      threadTs: "thread-root",
      messageTs: "100.000001",
      text: "Investigate",
    });
    if (delivery === undefined) throw new Error("Expected recovery fixture");
    harness.store.bind(delivery.conversationKey, "native-thread", "/synthetic/project");
    harness.store.dispatch(delivery.eventId);
    harness.store.started(delivery.eventId, "native-turn-1");
    harness.request.mockImplementationOnce(async () => ({
      data: [{ id: "native-turn-1", status: "completed", items: [] }],
      nextCursor: null,
    }));
    await harness.service.recover();
    expect(harness.store.getConversation(delivery.conversationKey)?.state).toBe("idle");
    expect(harness.activities.at(-1)?.phase).toBe("idle");
    expect(harness.request.mock.calls.every(([method]) => method === "thread/turns/list")).toBe(
      true,
    );
  });

  it("resumes a durably proven unadmitted instruction after restart on the same native thread", async () => {
    const harness = setup();
    const root = harness.store.claim({
      eventId: "old-root",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      threadTs: "thread-root",
      messageTs: "100.000001",
      text: "Investigate",
    });
    if (root === undefined) throw new Error("Expected retained instruction fixture");
    harness.store.bind(root.conversationKey, "native-thread", "/synthetic/project");
    harness.store.dispatch(root.eventId);
    harness.store.started(root.eventId, "previous-turn");
    harness.store.claim({
      eventId: "retained",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      threadTs: "thread-root",
      messageTs: "100.000002",
      text: "Check the second synthetic target",
    });
    harness.store.steering("retained", "previous-turn");
    harness.store.markUnadmitted("retained", "previous-turn");
    harness.store.complete(root.eventId, "Previous result", "completed");
    await harness.service.recover();
    expect(harness.store.getDelivery("retained")?.state).toBe("running");
    expect(harness.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      0,
    );
    expect(harness.request).toHaveBeenCalledWith("turn/start", {
      threadId: "native-thread",
      input: [{ type: "text", text: "Check the second synthetic target", text_elements: [] }],
      clientUserMessageId: "retained",
    });
    harness.finish();
  });

  it("resumes every retained instruction in order without blocking startup on the first turn", async () => {
    const harness = setup();
    const root = harness.store.claim({
      eventId: "old-root",
      teamId: "T1",
      userId: "U1",
      channelId: "D1",
      threadTs: "thread-root",
      messageTs: "100.000001",
      text: "Investigate the synthetic root",
    });
    if (root === undefined) throw new Error("Expected a synthetic retained root");
    harness.store.bind(root.conversationKey, "native-thread", "/synthetic/project");
    harness.store.dispatch(root.eventId);
    harness.store.started(root.eventId, "previous-turn");
    for (const [index, eventId] of ["retained-first", "retained-second"].entries()) {
      harness.store.claim({
        eventId,
        teamId: "T1",
        userId: "U1",
        channelId: "D1",
        threadTs: "thread-root",
        messageTs: `100.00000${index + 2}`,
        text: eventId,
      });
      harness.store.steering(eventId, "previous-turn");
      harness.store.markUnadmitted(eventId, "previous-turn");
    }
    harness.store.complete(root.eventId, "Previous synthetic result", "completed");
    await harness.service.recover();
    expect(harness.store.getDelivery("retained-first")?.state).toBe("running");
    expect(harness.store.listUnadmitted().map((delivery) => delivery.eventId)).toEqual([
      "retained-second",
    ]);
    harness.finish("First retained result", "native-turn-1");
    await waitForTurn(harness, "retained-second");
    expect(
      harness.request.mock.calls
        .filter(([method]) => method === "turn/start")
        .map(([, params]) => params),
    ).toEqual([
      {
        threadId: "native-thread",
        clientUserMessageId: "retained-first",
        input: [{ type: "text", text: "retained-first", text_elements: [] }],
      },
      {
        threadId: "native-thread",
        clientUserMessageId: "retained-second",
        input: [{ type: "text", text: "retained-second", text_elements: [] }],
      },
    ]);
    expect(harness.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      0,
    );
    harness.finish("Second retained result", "native-turn-2");
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("retained-second")?.completionStatus).toBe("completed"),
    );
    expect(harness.store.listUnadmitted()).toEqual([]);
  });

  it("preserves ordinary requests and resumes the same native conversation", async () => {
    const harness = setup();
    const first = harness.service.handleMention(harness.input("first", "root cause"));
    await waitForTurn(harness, "first");
    harness.finish();
    await first;
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("first")?.deliveryMessageTs).toBe("bot-receipt-1"),
    );
    const second = harness.service.handleMention(harness.input("second", "continue investigating"));
    await waitForTurn(harness, "second");
    harness.finish("Follow-up answer", "native-turn-2");
    await second;
    expect(harness.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(
      1,
    );
    expect(harness.request.mock.calls).toContainEqual([
      "thread/resume",
      { threadId: "native-thread", cwd: "/synthetic/project" },
    ]);
    expect(harness.request.mock.calls).toContainEqual([
      "turn/start",
      {
        threadId: "native-thread",
        clientUserMessageId: "second",
        input: [{ type: "text", text: "continue investigating", text_elements: [] }],
      },
    ]);
  });

  it("persists completion even when it arrives before the turn-start response", async () => {
    const harness = setup();
    const start = deferred<unknown>();
    const original = harness.request.getMockImplementation();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") {
        harness.emit({
          method: "turn/started",
          params: { threadId: "native-thread", turn: { id: "native-turn-1" } },
        });
        harness.finish("Early native final");
        return start.promise;
      }
      return original?.(method, params);
    });
    const handling = harness.service.handleMention(harness.input("early", "Investigate"));
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("early")?.finalText).toBe("Early native final"),
    );
    start.resolve({ turn: { id: "native-turn-1" } });
    await handling;
    expect(harness.store.getDelivery("early")?.completionStatus).toBe("completed");
  });

  it("waits for a steering acknowledgement and records only the actual shared final receipt", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    const steer = deferred<unknown>();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/steer") return steer.promise;
      return original?.(method, params);
    });
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("followup", "Also check the linked evidence"),
    );
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("followup")?.state).toBe("dispatching"),
    );
    harness.finish("Combined native answer");
    expect(harness.store.getDelivery("root")?.finalText).toBe("Combined native answer");
    expect(harness.store.getDelivery("followup")?.deliveryMessageTs).toBeUndefined();
    steer.resolve({ turnId: "native-turn-1" });
    await Promise.all([first, followup]);
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("root")?.deliveryMessageTs).toBeDefined(),
    );
    const root = harness.store.getDelivery("root");
    expect(harness.store.getDelivery("followup")).toMatchObject({
      rootEventId: "root",
      finalText: "Combined native answer",
      completionStatus: "completed",
      deliveryMessageTs: root?.deliveryMessageTs,
    });
    expect(root?.deliveryMessageTs).not.toBe("user-message-followup");
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.setMessageStatus.mock.calls).toEqual([
      [{ channelId: "D1", messageTs: "100.000001" }, "completed", "working"],
      [{ channelId: "D1", messageTs: "100.000002" }, "completed", "working"],
    ]);
  });

  it("retries linked message reactions without repeating the shared final delivery", async () => {
    const harness = setup();
    vi.useFakeTimers();
    await harness.service.recover();
    harness.setMessageStatus
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("Synthetic follow-up reaction failed"));
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("followup", "Check another synthetic target"),
    );
    await vi.waitFor(() => expect(harness.store.getDelivery("followup")?.rootEventId).toBe("root"));
    harness.finish("Combined synthetic result");
    await Promise.all([first, followup]);
    await vi.waitFor(() => expect(harness.setMessageStatus).toHaveBeenCalledTimes(2));
    expect(harness.store.getDelivery("root")?.deliveryMessageTs).toBeUndefined();
    expect(harness.store.getDelivery("followup")?.deliveryMessageTs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("followup")?.deliveryMessageTs).toBe("bot-receipt-1"),
    );
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.setMessageStatus.mock.calls).toEqual([
      [{ channelId: "D1", messageTs: "100.000001" }, "completed", "working"],
      [{ channelId: "D1", messageTs: "100.000002" }, "completed", "working"],
      [{ channelId: "D1", messageTs: "100.000001" }, "completed", "working"],
      [{ channelId: "D1", messageTs: "100.000002" }, "completed", "working"],
    ]);
  });

  it.each(["acknowledgement", "reconciliation"])(
    "holds delivery flushes until steering %s has linked the follow-up",
    async (admission) => {
      const harness = setup();
      vi.useFakeTimers();
      await harness.service.recover();
      const original = harness.request.getMockImplementation();
      const steer = deferred<unknown>();
      const reconciliation = deferred<unknown>();
      harness.request.mockImplementation(async (method, params) => {
        if (method === "turn/steer") return steer.promise;
        if (method === "thread/turns/list") return reconciliation.promise;
        return original?.(method, params);
      });
      const first = harness.service.handleMention(harness.input("root", "Investigate"));
      await waitForTurn(harness, "root");
      const followup = harness.service.handleMention(
        harness.input("followup", "Check another synthetic target"),
      );
      await vi.waitFor(() =>
        expect(harness.store.getDelivery("followup")?.state).toBe("dispatching"),
      );
      if (admission === "reconciliation") {
        steer.reject(new Error("Synthetic steering acknowledgement lost"));
        await vi.waitFor(() =>
          expect(
            harness.request.mock.calls.some(([method]) => method === "thread/turns/list"),
          ).toBe(true),
        );
      }
      harness.finish("Combined synthetic result");
      expect(harness.store.getDelivery("root")?.finalText).toBe("Combined synthetic result");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.post).not.toHaveBeenCalled();
      expect(harness.setMessageStatus).not.toHaveBeenCalled();
      expect(harness.store.getDelivery("root")?.deliveryMessageTs).toBeUndefined();
      if (admission === "reconciliation") {
        reconciliation.resolve({
          data: [
            {
              id: "native-turn-1",
              status: "completed",
              items: [{ type: "userMessage", clientId: "followup" }],
            },
          ],
          nextCursor: null,
        });
      } else {
        steer.resolve({ turnId: "native-turn-1" });
      }
      await Promise.all([first, followup]);
      await vi.waitFor(() =>
        expect(harness.store.getDelivery("followup")?.deliveryMessageTs).toBe("bot-receipt-1"),
      );
      expect(harness.post).toHaveBeenCalledTimes(1);
      expect(harness.setMessageStatus.mock.calls).toEqual([
        [{ channelId: "D1", messageTs: "100.000001" }, "completed", "working"],
        [{ channelId: "D1", messageTs: "100.000002" }, "completed", "working"],
      ]);
    },
  );

  it("does not give a rejected steer credit for the original turn's answer", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    const steer = deferred<unknown>();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/steer") return steer.promise;
      return original?.(method, params);
    });
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("rejected", "Check one more thing"),
    );
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("rejected")?.state).toBe("dispatching"),
    );
    harness.finish("Original answer");
    steer.reject(new Error("The expected native turn already ended"));
    await Promise.all([first, followup]);
    expect(harness.store.getDelivery("rejected")).toMatchObject({
      completionStatus: "uncertain",
      finalText: "The expected native turn already ended",
    });
    expect(harness.store.getDelivery("rejected")?.rootEventId).toBeUndefined();
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("rejected")?.deliveryMessageTs).toBeDefined(),
    );
    expect(harness.activities.at(-1)).toMatchObject({ needsReconciliation: true });
  });

  it("keeps native final text durable and followers undelivered when Slack fails", async () => {
    const harness = setup();
    vi.useFakeTimers();
    await harness.service.recover();
    harness.post.mockRejectedValue(new Error("Synthetic Slack outage"));
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const followup = harness.service.handleMention(
      harness.input("followup", "Check the report too"),
    );
    await vi.waitFor(() => expect(harness.store.getDelivery("followup")?.rootEventId).toBe("root"));
    harness.finish("Persist this native answer");
    await Promise.all([first, followup]);
    expect(harness.store.getDelivery("root")?.finalText).toBe("Persist this native answer");
    expect(harness.store.getDelivery("followup")?.deliveryMessageTs).toBeUndefined();
    expect(harness.store.pendingDeliveries().map((delivery) => delivery.eventId)).toEqual(["root"]);
    await vi.waitFor(() => expect(harness.store.getFinalParts("root")[0]?.state).toBe("uncertain"));
    const attempts = harness.post.mock.calls.length;
    harness.reconcile.mockResolvedValue({ status: "found", messageTs: "bot-receipt-1" });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(harness.reconcile).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("followup")?.deliveryMessageTs).toBe("bot-receipt-1"),
    );
    expect(harness.post).toHaveBeenCalledTimes(attempts);
  });

  it("does not dispatch after runtime ownership is lost during native setup", async () => {
    const harness = setup();
    harness.request.mockImplementationOnce(async () => {
      harness.setOwned(false);
      return { thread: { id: "native-thread" } };
    });
    await expect(
      harness.service.handleMention(harness.input("lost", "Make the requested change")),
    ).rejects.toThrow("ownership lost");
    expect(harness.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    harness.setOwned(true);
  });

  it("settles an admission when dispatch bookkeeping fails and allows a later request", async () => {
    const harness = setup();
    vi.spyOn(harness.store, "dispatch").mockImplementationOnce(() => {
      throw new Error("Synthetic dispatch bookkeeping failure");
    });
    await harness.service.handleMention(harness.input("failed", "Investigate"));
    expect(harness.store.getDelivery("failed")?.completionStatus).toBe("failed");
    expect(harness.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    const next = harness.service.handleMention(harness.input("next", "Investigate again"));
    await waitForTurn(harness, "next");
    harness.finish();
    await next;
  });

  it("does not send invalid or expired answer controls to the model", async () => {
    const harness = setup();
    await harness.service.handleMention(
      harness.input("answer", "answer 00000000-0000-0000-0000-000000000000 invalid"),
    );
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.store.getDelivery("answer")?.finalText).toContain("not sent");
    expect(harness.store.getDelivery("answer")?.deliveryMessageTs).toBe("bot-receipt-1");
  });

  it("keeps commentary and final deltas private until one final result is delivered", async () => {
    const harness = setup();
    const handling = harness.service.handleMention(harness.input("commentary", "Investigate"));
    await waitForTurn(harness, "commentary");
    harness.emit({
      method: "item/started",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        item: { id: "commentary", type: "agentMessage", phase: "commentary", text: "" },
      },
    });
    harness.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        itemId: "commentary",
        delta: "Checking the primary evidence",
      },
    });
    harness.emit({
      method: "item/completed",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        item: {
          id: "commentary",
          type: "agentMessage",
          phase: "commentary",
          text: "Checking the primary evidence",
        },
      },
    });
    harness.emit({
      method: "item/started",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        item: {
          id: "reasoning",
          type: "reasoning",
          summary: ["Synthetic internal reasoning"],
          content: [],
        },
      },
    });
    harness.emit({
      method: "item/started",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        item: { id: "final-message", type: "agentMessage", phase: "final_answer", text: "" },
      },
    });
    harness.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        itemId: "final-message",
        delta: "Synthetic final result",
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.post).not.toHaveBeenCalled();
    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.activities.at(-1)?.phase).toBe("executing");
    harness.emit({
      method: "turn/started",
      params: { threadId: "native-thread", turn: { id: "unrelated-turn" } },
    });
    expect(harness.store.getDelivery("commentary")?.nativeTurnId).toBe("native-turn-1");
    harness.finish("Synthetic final result");
    await handling;
    expect(harness.store.getDelivery("commentary")?.completionStatus).toBe("completed");
    await vi.waitFor(() =>
      expect(harness.store.getDelivery("commentary")?.deliveryMessageTs).toBe("bot-receipt-1"),
    );
    expect(harness.post).toHaveBeenCalledTimes(1);
    expect(harness.post).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "commentary" }),
      "Synthetic final result",
      expect.objectContaining({ part: 0 }),
    );
    expect(harness.update).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not turn commentary-only completion into a final answer when snapshotOnly=%s",
    async (snapshotOnly) => {
      const harness = setup();
      const handling = harness.service.handleMention(
        harness.input("commentary-only", "Investigate"),
      );
      await waitForTurn(harness, "commentary-only");
      const commentary = {
        id: "commentary-only-item",
        type: "agentMessage",
        phase: "commentary",
        text: "Synthetic intermediate commentary that must stay private",
      };
      if (!snapshotOnly) {
        harness.emit({
          method: "item/completed",
          params: { threadId: "native-thread", turnId: "native-turn-1", item: commentary },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(harness.post).not.toHaveBeenCalled();
        expect(harness.update).not.toHaveBeenCalled();
      }
      harness.emit({
        method: "turn/completed",
        params: {
          threadId: "native-thread",
          turn: { id: "native-turn-1", status: "completed", items: [commentary] },
        },
      });
      await handling;
      expect(harness.store.getDelivery("commentary-only")?.finalText).toBe(
        "Codex completed without a final response.",
      );
      await vi.waitFor(() => expect(harness.post).toHaveBeenCalledTimes(1));
      expect(harness.post).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: "commentary-only" }),
        "Codex completed without a final response.",
        expect.objectContaining({ part: 0 }),
      );
      expect(JSON.stringify(harness.post.mock.calls)).not.toContain(commentary.text);
    },
  );

  it.each([null, undefined])(
    "preserves a terminal compatibility answer with phase=%s while excluding commentary",
    async (phase) => {
      const harness = setup();
      const handling = harness.service.handleMention(
        harness.input("compatible-final", "Investigate"),
      );
      await waitForTurn(harness, "compatible-final");
      harness.emit({
        method: "turn/completed",
        params: {
          threadId: "native-thread",
          turn: {
            id: "native-turn-1",
            status: "completed",
            items: [
              {
                id: "compatible-answer",
                type: "agentMessage",
                text: "Synthetic compatible final result",
                ...(phase === undefined ? {} : { phase }),
              },
              {
                id: "late-commentary",
                type: "agentMessage",
                phase: "commentary",
                text: "Synthetic later commentary that must stay private",
              },
            ],
          },
        },
      });
      await handling;
      expect(harness.store.getDelivery("compatible-final")?.finalText).toBe(
        "Synthetic compatible final result",
      );
      await vi.waitFor(() => expect(harness.post).toHaveBeenCalledTimes(1));
      expect(harness.post).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: "compatible-final" }),
        "Synthetic compatible final result",
        expect.objectContaining({ part: 0 }),
      );
      expect(harness.update).not.toHaveBeenCalled();
    },
  );

  it("does not return an approval grant after runtime ownership is lost", async () => {
    const harness = setup();
    const handling = harness.service.handleMention(
      harness.input("approval", "Perform the requested work"),
    );
    await waitForTurn(harness, "approval");
    const response = harness.serverRequest("item/commandExecution/requestApproval", {
      threadId: "native-thread",
      turnId: "native-turn-1",
      itemId: "command",
      command: "printf synthetic",
    });
    const rejected = expect(response).rejects.toThrow("ownership lost");
    await vi.waitFor(() => expect(harness.approval).toHaveBeenCalled());
    const posted = harness.approval.mock.calls[0]?.[0];
    if (posted === undefined) throw new Error("Expected a synthetic approval prompt");
    const input = harness.input("approval", "");
    const approving = harness.service.handleApproval({
      approvalId: posted.approvalId,
      approved: true,
      identity: input.identity,
      replyContext: { channelId: input.identity.channelId, threadTs: input.slackThreadTs },
      responder: input.responder,
    });
    harness.setOwned(false);
    await approving;
    await rejected;
    harness.setOwned(true);
    harness.finish();
    await handling;
  });

  it("settles an image admission queued behind a turn during shutdown", async () => {
    const harness = setup();
    const first = harness.service.handleMention(harness.input("root", "Investigate"));
    await waitForTurn(harness, "root");
    const second = harness.service.handleMention({
      ...harness.input("image", "Also inspect this image"),
      imagePaths: ["/synthetic/image.png"],
    });
    await vi.waitFor(() => expect(harness.store.getDelivery("image")?.state).toBe("queued"));
    await harness.service.shutdown();
    await Promise.all([first, second]);
    expect(harness.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
      1,
    );
    expect(harness.store.getDelivery("image")?.completionStatus).toBe("failed");
  });

  it("persists the final and fences late database reads after a hanging final delivery shuts down", async () => {
    const harness = setup();
    const final = deferred<string>();
    harness.post.mockImplementationOnce(async () => final.promise);
    const handling = harness.service.handleMention(harness.input("hanging-final", "Investigate"));
    await waitForTurn(harness, "hanging-final");
    harness.finish("Durable native final");
    await handling;
    await vi.waitFor(() => expect(harness.post).toHaveBeenCalledTimes(1));
    expect(harness.store.getDelivery("hanging-final")).toMatchObject({
      finalText: "Durable native final",
      completionStatus: "completed",
    });
    vi.useFakeTimers();
    const stopping = harness.service.shutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    const lateRead = vi.spyOn(harness.store, "getDelivery");
    final.resolve("synthetic-final-receipt");
    for (let count = 0; count < 10; count += 1) await Promise.resolve();
    expect(lateRead).not.toHaveBeenCalled();
  });

  it("closes the owned native connection when an interrupt never responds", async () => {
    const harness = setup();
    const original = harness.request.getMockImplementation();
    harness.request.mockImplementation(async (method, params) => {
      if (method === "turn/interrupt") return new Promise(() => {});
      return original?.(method, params);
    });
    const handling = harness.service.handleMention(harness.input("shutdown", "Investigate"));
    await waitForTurn(harness, "shutdown");
    vi.useFakeTimers();
    const stopping = harness.service.shutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
    await handling;
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.store.getDelivery("shutdown")?.completionStatus).toBe("uncertain");
  });
});
