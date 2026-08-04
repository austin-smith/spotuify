import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenStore } from "../src/auth/tokens.ts";
import {
  createCliSession,
  primeCliSessionForTests,
  resetCliSessionForTests,
} from "../src/cli/session.ts";
import {
  pausePlayback,
  seekPlayback,
  setVolume,
  skip,
  startPlayback,
} from "../src/cli/operations/playback.ts";
import { queueAdd } from "../src/cli/operations/queue.ts";
import {
  startControlServer,
  type ControlPaths,
  type ControlServer,
} from "../src/runtime/control.ts";

const realFetch = globalThis.fetch;
const realRuntimeDir = process.env["SPOTUIFY_RUNTIME_DIR"];

let server: ControlServer | undefined;
let directory: string | undefined;
let sessionDirectory: string | undefined;

async function runtimePaths(): Promise<ControlPaths> {
  const socketRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  directory = await mkdtemp(join(socketRoot, "spotuify-operations-test-"));
  return {
    directory,
    descriptor: join(directory, "control.json"),
    endpoint: join(directory, "control.sock"),
  };
}

/** Start a recording runtime and point the operations' default control paths at it. */
async function startFakeRuntime(
  respond: (method: string, params: unknown) => unknown,
): Promise<{ calls: { method: string; params: unknown }[] }> {
  const calls: { method: string; params: unknown }[] = [];
  const paths = await runtimePaths();
  server = await startControlServer(
    (method, params) => {
      calls.push({ method, params });
      return respond(method, params);
    },
    { paths },
  );
  process.env["SPOTUIFY_RUNTIME_DIR"] = paths.directory;
  return { calls };
}

/** Point the default control paths at an empty directory: no runtime is reachable. */
async function withoutRuntime(): Promise<void> {
  const paths = await runtimePaths();
  process.env["SPOTUIFY_RUNTIME_DIR"] = paths.directory;
}

/** Prime the shared session with a fake token store and a recording Web API. */
async function primeWebSession(
  respond: (path: string, init?: RequestInit) => Response,
): Promise<string[]> {
  const paths: string[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = new URL(String(input)).pathname.replace("/v1", "");
    paths.push(path);
    return respond(path, init);
  }) as unknown as typeof fetch;
  const tokens = {
    accessToken: async () => "token",
    refresh: async () => {
      throw new Error("unexpected refresh");
    },
    authorizationId: async () => "authorization",
  } as unknown as TokenStore;
  sessionDirectory = await mkdtemp(
    join(tmpdir(), "spotuify-operations-session-"),
  );
  primeCliSessionForTests(
    await createCliSession(tokens, {
      profilePath: join(sessionDirectory, "profile.json"),
    }),
  );
  return paths;
}

beforeEach(() => {
  resetCliSessionForTests();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (realRuntimeDir === undefined) delete process.env["SPOTUIFY_RUNTIME_DIR"];
  else process.env["SPOTUIFY_RUNTIME_DIR"] = realRuntimeDir;
  resetCliSessionForTests();
  await server?.close();
  server = undefined;
  for (const path of [directory, sessionDirectory]) {
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
  directory = undefined;
  sessionDirectory = undefined;
});

describe("operation validation", () => {
  test("startPlayback refuses an index without a context target", async () => {
    await expect(startPlayback({ index: 3 })).rejects.toThrow(
      "requires an album or playlist target",
    );
  });

  test("startPlayback refuses an index on a track", async () => {
    await expect(
      startPlayback({ target: "spotify:track:abc123", index: 2 }),
    ).rejects.toThrow("only valid for album or playlist contexts");
  });

  test("startPlayback refuses a show context with the episode hint", async () => {
    await expect(startPlayback({ target: "spotify:show:abc123" })).rejects.toThrow(
      "cannot be played as a context",
    );
  });

  test("seekPlayback refuses a position and an offset together", async () => {
    await expect(
      seekPlayback({ positionMs: 1_000, offsetMs: 1_000 }),
    ).rejects.toThrow("not both");
  });

  test("setVolume bounds an absolute level", async () => {
    await expect(setVolume({ percent: 101 })).rejects.toThrow(
      "between 0 and 100",
    );
  });

  test("queueAdd accepts only tracks and episodes", async () => {
    await expect(queueAdd(["spotify:album:abc123"])).rejects.toThrow(
      "Only tracks and episodes",
    );
  });
});

describe("runtime-first routing", () => {
  test("startPlayback without a device hands the command to the runtime", async () => {
    const { calls } = await startFakeRuntime(() => ({ isPlaying: true }));
    const result = await startPlayback({ target: "spotify:track:abc123" });
    expect(calls).toEqual([
      { method: "play", params: { uris: ["spotify:track:abc123"] } },
    ]);
    expect(result.data["source"]).toBe("runtime");
    expect(result.message).toBe("Playing spotify:track:abc123.");
  });

  test("startPlayback aimed at the idle receiver transfers natively first", async () => {
    const { calls } = await startFakeRuntime((method) =>
      method === "device.list"
        ? {
            devices: [
              {
                id: "local-id",
                name: "spotuify",
                type: "Computer",
                is_active: false,
                is_restricted: false,
                volume_percent: 50,
              },
            ],
            localDeviceId: "local-id",
          }
        : {},
    );
    const result = await startPlayback({
      target: "spotify:album:abc123",
      device: "spotuify",
      index: 2,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "device.list",
      "device.transfer",
      "play",
    ]);
    expect(calls[1]?.params).toEqual({ selector: "local-id", play: false });
    expect(calls[2]?.params).toEqual({
      contextUri: "spotify:album:abc123",
      offset: 1,
    });
    expect(result.data["deviceId"]).toBe("local-id");
  });

  test("a relative seek sends the raw offset for serialized application", async () => {
    const { calls } = await startFakeRuntime(() => ({ progressMs: 4_000 }));
    const result = await seekPlayback({ offsetMs: -2_000 });
    expect(calls).toEqual([
      { method: "seek", params: { offsetMs: -2_000 } },
    ]);
    expect(result.data["positionMs"]).toBe(4_000);
  });

  test("an absolute seek clamps the position before sending it", async () => {
    const { calls } = await startFakeRuntime(() => ({ progressMs: 0 }));
    await seekPlayback({ positionMs: 5_000 });
    expect(calls).toEqual([
      { method: "seek", params: { positionMs: 5_000 } },
    ]);
  });

  test("a relative volume change sends the raw delta", async () => {
    const { calls } = await startFakeRuntime(() => ({
      device: { volumePercent: 55 },
    }));
    const result = await setVolume({ delta: 5 });
    expect(calls).toEqual([{ method: "volume", params: { delta: 5 } }]);
    expect(result.data["volumePercent"]).toBe(55);
    expect(result.message).toBe("Volume set to 55%.");
  });

  test("queueAdd serializes every addition through the runtime", async () => {
    const { calls } = await startFakeRuntime(() => ({}));
    const result = await queueAdd([
      "spotify:track:aaa111",
      "spotify:track:bbb222",
    ]);
    expect(calls).toEqual([
      { method: "queue.add", params: { uri: "spotify:track:aaa111" } },
      { method: "queue.add", params: { uri: "spotify:track:bbb222" } },
    ]);
    expect(result.data["source"]).toBe("runtime");
  });
});

describe("web fallback routing", () => {
  test("pausePlayback falls back to the Web API without a runtime", async () => {
    await withoutRuntime();
    const paths = await primeWebSession(() => new Response(null, { status: 204 }));
    const result = await pausePlayback();
    expect(paths).toEqual(["/me/player/pause"]);
    expect(result.data).toEqual({ deviceId: null });
    expect(result.message).toBe("Playback paused.");
  });

  test("skip falls back to the Web API without a runtime", async () => {
    await withoutRuntime();
    const paths = await primeWebSession(() => new Response(null, { status: 204 }));
    const result = await skip("next");
    expect(paths).toEqual(["/me/player/next"]);
    expect(result.message).toBe("Skipped to next item.");
  });

  test("a relative web seek resolves the current position first", async () => {
    await withoutRuntime();
    const paths = await primeWebSession((path) =>
      path === "/me/player"
        ? Response.json({
            is_playing: true,
            progress_ms: 10_000,
            item: null,
            shuffle_state: false,
            repeat_state: "off",
            context: null,
            device: null,
          })
        : new Response(null, { status: 204 }),
    );
    const result = await seekPlayback({ offsetMs: -4_000 });
    expect(paths).toEqual(["/me/player", "/me/player/seek"]);
    expect(result.data["positionMs"]).toBe(6_000);
  });

  test("queueAdd falls back to one Web request per item", async () => {
    await withoutRuntime();
    const paths = await primeWebSession(() => new Response(null, { status: 204 }));
    const result = await queueAdd([
      "spotify:track:aaa111",
      "spotify:episode:bbb222",
    ]);
    expect(paths).toEqual(["/me/player/queue", "/me/player/queue"]);
    expect(result.data["deviceId"]).toBe(null);
  });
});
