import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlackApp } from "../src/slack/app.js";
import type { SlackConnectionState } from "../src/slack/connection-lifecycle.js";

const apps: ReturnType<typeof createSlackApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function fixture(fetch: typeof globalThis.fetch) {
  const states: SlackConnectionState[] = [];
  const app = createSlackApp(
    {
      appToken: "xapp-synthetic",
      botToken: "xoxb-synthetic",
      allowedTeamId: "T_TEST",
      allowedUserId: "U_TEST",
      allowedChannelIds: new Set(["C_TEST"]),
      workspaces: { demo: "/private/tmp" },
      databasePath: ":memory:",
      logLevel: "silent",
      maxSlackResponseChars: 3_500,
    },
    {
      logger: pino({ level: "silent" }),
      store: {
        claimEvent: () => true,
        claimMessage: () => true,
        findTrackedRun: () => undefined,
      },
      service: {
        handleMention: vi.fn(async () => {}),
        handleApproval: vi.fn(async () => {}),
        handleStopRun: vi.fn(async () => {}),
        handleNewSession: vi.fn(async () => {}),
      },
      slackFetch: fetch,
      onConnectionState: (state) => {
        states.push(state);
      },
    },
  );
  apps.push(app);
  return { app, states };
}

describe("pinned Slack SDK startup contract", () => {
  it("defers constructor authorization and explicitly awaits the only auth request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ ok: true, user_id: "U_SYNTHETIC", bot_id: "B_SYNTHETIC" }),
    );
    const value = fixture(fetch);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    await value.app.init();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toContain("auth.test");
    expect(value.states.some((state) => state.connected)).toBe(false);
  });

  it("returns initialization network failures without starting a socket or retrying invisibly", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("Synthetic authorization transport failure");
    });
    const value = fixture(fetch);
    await expect(value.app.init()).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(value.states.some((state) => state.connected)).toBe(false);
    await expect(Promise.resolve().then(() => value.app.start())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("contains repeated real SDK connection URL failures under the owned retry supervisor", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("auth.test"))
        return response({ ok: true, user_id: "U_SYNTHETIC", bot_id: "B_SYNTHETIC" });
      throw new Error("Synthetic connection URL transport failure");
    });
    const value = fixture(fetch);
    await value.app.init();
    const starting = value.app.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const delay of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(value.states.filter((state) => state.state === "reconnecting")).toHaveLength(3);
    expect(value.states.some((state) => state.connected)).toBe(false);
    await value.app.stop();
    expect(await starting).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("permanently cancels initialization when stopped and rejects an ignored-abort late response", async () => {
    let release = (_response: Response) => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending);
    const value = fixture(fetch);
    const initialization = value.app.init().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await value.app.stop();
    const requestSignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(requestSignal?.aborted).toBe(true);
    release(response({ ok: true, user_id: "U_SYNTHETIC", bot_id: "B_SYNTHETIC" }));
    expect(await initialization).toBeInstanceOf(Error);
    await expect(value.app.init()).rejects.toThrow();
    await expect(Promise.resolve().then(() => value.app.start())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(value.states.some((state) => state.connected)).toBe(false);
    expect(value.states.at(-1)).toMatchObject({ state: "stopped", connected: false });
  });

  it("does not authorize or reconnect after stop occurs before initialization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ ok: true }));
    const value = fixture(fetch);
    await value.app.stop();
    await expect(value.app.init()).rejects.toThrow();
    await expect(Promise.resolve().then(() => value.app.start())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(value.states.some((state) => state.connected)).toBe(false);
  });
});
