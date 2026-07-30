import { afterEach, describe, expect, test } from "bun:test";
import {
  PlayerCommandRejectedError,
  PremiumRequiredError,
  SpotifyApiError,
  SpotifyClient,
  SpotifyLimitError,
} from "../src/api/client.ts";
import { PlayerApi } from "../src/api/player.ts";
import type { TokenStore } from "../src/auth/tokens.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

/** Answer every request with one canned response. */
function reply(body: string, init: ResponseInit = {}) {
  globalThis.fetch = (async () => new Response(body, init)) as unknown as typeof fetch;
}

function client() {
  return new SpotifyClient(tokens);
}

describe("response bodies", () => {
  // Measured against the live API: POST /me/player/next answers 200 with a bare command id and no
  // content-type at all, e.g. `xnhCFLSU-oYEeK59yBVw1tAwgNI`. Parsing that as JSON threw a raw
  // SyntaxError, so every transport keypress flashed an error despite having worked.
  test("a 200 with an unlabelled body is not parsed", async () => {
    reply("xnhCFLSU-oYEeK59yBVw1tAwgNI", { status: 200 });
    expect(await client().request("/me/player/next", { method: "POST" })).toBeNull();
  });

  test("transport commands resolve rather than throw", async () => {
    reply("-FB36txrEzLayIL3bX9HNyXUTtw", { status: 200 });
    const player = new PlayerApi(client());
    // Each of these is a keypress; none of them may reject.
    await player.next();
    await player.previous();
    await player.pause();
    await player.seek(1_000);
  });

  test("a body labelled as JSON is parsed", async () => {
    reply(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(await client().request<{ ok: boolean }>("/me")).toEqual({ ok: true });
  });

  test("204 is null", async () => {
    reply("", { status: 204 });
    expect(await client().request("/me/player")).toBeNull();
  });

  test("an empty 200 is null", async () => {
    reply("", { status: 200, headers: { "content-type": "application/json" } });
    expect(await client().request("/me/player")).toBeNull();
  });

  // A JSON content-type with a broken body is a real fault, and has to say so as an API error
  // rather than leaking "JSON Parse error: …" to the user.
  test("malformed JSON becomes an API error", async () => {
    reply("{not json", { status: 200, headers: { "content-type": "application/json" } });
    expect(client().request("/me")).rejects.toBeInstanceOf(SpotifyApiError);
  });

  test("get() rejects when a body was expected but not sent", async () => {
    reply("", { status: 204 });
    expect(client().get("/me")).rejects.toBeInstanceOf(SpotifyApiError);
  });
});

describe("declined commands", () => {
  const declined = (message: string) =>
    reply(JSON.stringify({ error: { status: 403, message } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });

  // Pressing previous at the start of a context. Spotify's own clients do nothing here.
  test("'Player command failed' is typed separately", async () => {
    declined("Player command failed: Restriction violated");
    expect(client().request("/me/player/previous", { method: "POST" })).rejects.toBeInstanceOf(
      PlayerCommandRejectedError,
    );
  });

  test("the reason drops the boilerplate prefix", async () => {
    declined("Player command failed: Restriction violated");
    try {
      await client().request("/me/player/previous", { method: "POST" });
      throw new Error("should have rejected");
    } catch (err) {
      expect((err as PlayerCommandRejectedError).reason).toBe("Restriction violated");
    }
  });

  test("premium is still its own error", async () => {
    declined("Player command failed: Premium required");
    expect(client().request("/me/player/play", { method: "PUT" })).rejects.toBeInstanceOf(
      PremiumRequiredError,
    );
  });

  test("other 403s stay ordinary API errors", async () => {
    declined("Insufficient client scope");
    expect(client().request("/me/tracks")).rejects.toBeInstanceOf(SpotifyApiError);
  });
});

describe("SpotifyApiError", () => {
  test("keeps Spotify's own message separate from the prefixed one", () => {
    const err = new SpotifyApiError(404, "/me/player/next", "Device not found");
    expect(err.detail).toBe("Device not found");
    expect(err.message).toContain("404");
    expect(err.message).toContain("/me/player/next");
  });
});

describe("shared request coordination", () => {
  test("coalesces identical GETs before they reach the network", async () => {
    let requests = 0;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      requests++;
      await waiting;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const spotify = client();
    const first = spotify.request<{ ok: boolean }>("/me/player");
    const second = spotify.request<{ ok: boolean }>("/me/player");
    release?.();

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(requests).toBe(1);
    expect(spotify.getMetrics().coalescedRequests).toBe(1);
  });

  test("serializes unrelated requests", async () => {
    let active = 0;
    let mostActive = 0;
    globalThis.fetch = (async () => {
      active++;
      mostActive = Math.max(mostActive, active);
      await Bun.sleep(5);
      active--;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const spotify = client();
    await Promise.all([spotify.request("/me"), spotify.request("/me/player")]);
    expect(mostActive).toBe(1);
  });

  test("foreground work goes before queued background polling", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      order.push(path);
      if (path.endsWith("/first")) await firstBlocked;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const spotify = client();
    const first = spotify.request("/first", { priority: "background" });
    await Bun.sleep(1);
    const background = spotify.request("/background", { priority: "background" });
    const foreground = spotify.request("/foreground");
    release?.();
    await Promise.all([first, background, foreground]);

    expect(order).toEqual(["/v1/first", "/v1/foreground", "/v1/background"]);
  });

  test("a slow background read cannot head-of-line block interactive work", async () => {
    let release: (() => void) | undefined;
    const backgroundBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let foregroundFinished = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/library")) await backgroundBlocked;
      if (path.endsWith("/search")) foregroundFinished = true;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const spotify = client();
    const background = spotify.request("/library", { priority: "background" });
    await Bun.sleep(1);
    const foreground = spotify.request("/search");
    await foreground;

    expect(foregroundFinished).toBeTrue();
    release?.();
    await background;
  });
});

describe("429 handling", () => {
  const quotaBody = JSON.stringify({
    error: { status: 429, message: "Too many requests", reason: "QUOTA_EXCEEDED" },
  });

  test("parses quota exhaustion before returning and does not retry", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "21600" },
      });
    }) as unknown as typeof fetch;

    const spotify = client();
    try {
      await spotify.request("/me/player");
      throw new Error("should have rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(SpotifyLimitError);
      expect((err as SpotifyLimitError).quotaExceeded).toBeTrue();
      expect((err as SpotifyLimitError).retryAt).not.toBeNull();
    }
    expect(requests).toBe(1);
  });

  test("one 429 blocks every later endpoint without another network request", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "21600" },
      });
    }) as unknown as typeof fetch;

    const spotify = client();
    await expect(spotify.request("/me/player")).rejects.toBeInstanceOf(SpotifyLimitError);
    await expect(spotify.request("/search", { query: { q: "test" } })).rejects.toBeInstanceOf(
      SpotifyLimitError,
    );
    await expect(
      spotify.request("/me/player/next", { method: "POST" }),
    ).rejects.toBeInstanceOf(SpotifyLimitError);

    expect(requests).toBe(1);
    expect(spotify.getMetrics().blockedRequests).toBe(2);
  });

  test("an empty 429 body still opens the shared circuit", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(null, {
        status: 429,
        headers: { "content-length": "0", "retry-after": "60" },
      });
    }) as unknown as typeof fetch;

    const spotify = client();
    await expect(spotify.request("/me/player")).rejects.toBeInstanceOf(SpotifyLimitError);
    await expect(spotify.request("/search")).rejects.toBeInstanceOf(SpotifyLimitError);
    expect(requests).toBe(1);
  });

  test("a lane waiting on credentials rechecks a cooldown before reaching Spotify", async () => {
    let tokenReads = 0;
    let releaseForeground: (() => void) | undefined;
    const foregroundToken = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    const gatedTokens = {
      accessToken: async () => {
        tokenReads++;
        if (tokenReads === 2) await foregroundToken;
        return "token";
      },
    } as unknown as TokenStore;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(gatedTokens);
    const background = spotify.request("/poll", { priority: "background" });
    const backgroundAssertion = expect(background).rejects.toBeInstanceOf(SpotifyLimitError);
    await Bun.sleep(1);
    const foreground = spotify.request("/search");
    await backgroundAssertion;
    releaseForeground?.();
    await expect(foreground).rejects.toBeInstanceOf(SpotifyLimitError);

    expect(requests).toBe(1);
  });

  test("allows requests again only after Spotify's Retry-After time", async () => {
    let now = 10_000;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (requests === 1) {
        return new Response(quotaBody, {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "10" },
        });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(tokens, {
      now: () => now,
    });
    await expect(spotify.request("/me/player")).rejects.toBeInstanceOf(SpotifyLimitError);

    now += 9_999;
    await expect(spotify.request("/me")).rejects.toBeInstanceOf(SpotifyLimitError);
    expect(requests).toBe(1);

    now++;
    expect(await spotify.request<{ ok: boolean }>("/me")).toEqual({ ok: true });
    expect(requests).toBe(2);
    expect(spotify.getCooldown()).toBeNull();
  });

  test("an elapsed HTTP-date Retry-After is immediately retryable", async () => {
    const now = Date.UTC(2026, 6, 29, 12, 0, 0, 750);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (requests === 1) {
        return new Response(quotaBody, {
          status: 429,
          headers: {
            "content-type": "application/json",
            // HTTP dates have only second precision, so this valid deadline is already 750ms behind
            // the client's current clock by the time the response is handled.
            "retry-after": new Date(now).toUTCString(),
          },
        });
      }
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(tokens, { now: () => now });
    await expect(spotify.request("/me/player")).rejects.toMatchObject({
      retryAt: now,
    });
    expect(await spotify.request<{ ok: boolean }>("/me")).toEqual({ ok: true });
    expect(requests).toBe(2);
  });

  test("an unusable Retry-After fails closed instead of guessing a retry cadence", async () => {
    globalThis.fetch = (async () =>
      new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "not-a-time" },
      })) as unknown as typeof fetch;

    const spotify = client();
    await expect(spotify.request("/me/player")).rejects.toBeInstanceOf(SpotifyLimitError);
    expect(spotify.getCooldown()).toEqual({
      kind: "quota",
      retryAt: null,
      detail: "Too many requests",
    });
  });

  test("an explicit probe can recover an indefinite cooldown without opening other traffic", async () => {
    let requests = 0;
    let releaseProbe: ((response: Response) => void) | undefined;
    const probeResponse = new Promise<Response>((resolve) => {
      releaseProbe = resolve;
    });
    globalThis.fetch = (async () => {
      requests++;
      if (requests === 1) {
        return new Response(quotaBody, {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "not-a-time",
          },
        });
      }
      return await probeResponse;
    }) as unknown as typeof fetch;

    const spotify = client();
    await expect(spotify.request("/me")).rejects.toBeInstanceOf(SpotifyLimitError);
    const probe = spotify.retryAfterIndefiniteCooldown<{ id: string }>("/me");
    await Bun.sleep(1);
    await expect(
      spotify.request("/poll", { priority: "background" }),
    ).rejects.toBeInstanceOf(SpotifyLimitError);
    expect(requests).toBe(2);

    releaseProbe?.(Response.json({ id: "user" }));
    expect(await probe).toEqual({ id: "user" });
    expect(spotify.getCooldown()).toBeNull();
  });

  test("an explicit probe never bypasses a finite Spotify deadline", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    }) as unknown as typeof fetch;

    const spotify = client();
    await expect(spotify.request("/me")).rejects.toBeInstanceOf(SpotifyLimitError);
    await expect(
      spotify.retryAfterIndefiniteCooldown("/me"),
    ).rejects.toBeInstanceOf(SpotifyLimitError);
    expect(requests).toBe(1);
  });

  test("a probe 429 replaces the indefinite cooldown with its new finite deadline", async () => {
    let now = 10_000;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(quotaBody, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": requests === 1 ? "invalid" : "30",
        },
      });
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(tokens, { now: () => now });
    await expect(spotify.request("/me")).rejects.toBeInstanceOf(SpotifyLimitError);
    await expect(
      spotify.retryAfterIndefiniteCooldown("/me"),
    ).rejects.toMatchObject({ retryAt: now + 30_000 });
    expect(spotify.getCooldown()?.retryAt).toBe(now + 30_000);
    expect(requests).toBe(2);
  });

  test("a queued probe cannot bypass a newer indefinite cooldown", async () => {
    let releaseRenewedCooldown: ((response: Response) => void) | undefined;
    const renewedCooldownResponse = new Promise<Response>((resolve) => {
      releaseRenewedCooldown = resolve;
    });
    let announceProbeToken: (() => void) | undefined;
    const probeTokenRequested = new Promise<void>((resolve) => {
      announceProbeToken = resolve;
    });
    let releaseProbeToken: ((token: string) => void) | undefined;
    const probeToken = new Promise<string>((resolve) => {
      releaseProbeToken = resolve;
    });
    let tokenRequests = 0;
    const gatedTokens = {
      accessToken: () => {
        tokenRequests++;
        if (tokenRequests !== 3) return Promise.resolve("test-token");
        announceProbeToken?.();
        return probeToken;
      },
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
    } as unknown as TokenStore;
    let announceBackgroundRequest: (() => void) | undefined;
    const backgroundRequestStarted = new Promise<void>((resolve) => {
      announceBackgroundRequest = resolve;
    });
    let requests = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requests++;
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/poll")) {
        announceBackgroundRequest?.();
        return await renewedCooldownResponse;
      }
      if (path.endsWith("/seed")) {
        return new Response(quotaBody, {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ id: "unexpected-probe" });
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(gatedTokens);
    const background = spotify.request("/poll", { priority: "background" });
    await backgroundRequestStarted;
    await expect(spotify.request("/seed")).rejects.toBeInstanceOf(SpotifyLimitError);

    const probe = spotify.retryAfterIndefiniteCooldown("/me");
    await probeTokenRequested;
    releaseRenewedCooldown?.(
      new Response(JSON.stringify({ error: { status: 429, message: "Still limited" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(background).rejects.toBeInstanceOf(SpotifyLimitError);
    releaseProbeToken?.("test-token");

    await expect(probe).rejects.toBeInstanceOf(SpotifyLimitError);
    expect(requests).toBe(2);
    expect(spotify.getMetrics().blockedRequests).toBe(1);
  });

  test("a shorter concurrent 429 cannot weaken an existing quota cooldown", async () => {
    let releaseQuota: ((response: Response) => void) | undefined;
    let releaseRateLimit: ((response: Response) => void) | undefined;
    const quotaResponse = new Promise<Response>((resolve) => {
      releaseQuota = resolve;
    });
    const rateLimitResponse = new Promise<Response>((resolve) => {
      releaseRateLimit = resolve;
    });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      return await (path.endsWith("/poll") ? quotaResponse : rateLimitResponse);
    }) as unknown as typeof fetch;

    const now = 10_000;
    const spotify = new SpotifyClient(tokens, { now: () => now });
    const background = spotify.request("/poll", { priority: "background" });
    const foreground = spotify.request("/search", { priority: "foreground" });

    releaseQuota?.(
      new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "21600" },
      }),
    );
    await expect(background).rejects.toBeInstanceOf(SpotifyLimitError);

    releaseRateLimit?.(
      new Response(JSON.stringify({ error: { status: 429, message: "Slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    );
    let foregroundError: unknown;
    try {
      await foreground;
    } catch (error) {
      foregroundError = error;
    }
    expect(foregroundError).toBeInstanceOf(SpotifyLimitError);
    expect((foregroundError as SpotifyLimitError).quotaExceeded).toBeTrue();
    expect((foregroundError as SpotifyLimitError).retryAt).toBe(now + 21_600_000);

    expect(spotify.getCooldown()).toEqual({
      kind: "quota",
      retryAt: now + 21_600_000,
      detail: "Too many requests",
    });
  });

  test("a finite concurrent 429 cannot replace an unknown fail-closed deadline", async () => {
    let releaseUnknown: ((response: Response) => void) | undefined;
    let releaseFinite: ((response: Response) => void) | undefined;
    const unknownResponse = new Promise<Response>((resolve) => {
      releaseUnknown = resolve;
    });
    const finiteResponse = new Promise<Response>((resolve) => {
      releaseFinite = resolve;
    });
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      return await (path.endsWith("/poll") ? unknownResponse : finiteResponse);
    }) as unknown as typeof fetch;

    const spotify = client();
    const background = spotify.request("/poll", { priority: "background" });
    const foreground = spotify.request("/search", { priority: "foreground" });

    releaseUnknown?.(
      new Response(quotaBody, {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(background).rejects.toBeInstanceOf(SpotifyLimitError);

    releaseFinite?.(
      new Response(JSON.stringify({ error: { status: 429, message: "Slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      }),
    );
    await expect(foreground).rejects.toBeInstanceOf(SpotifyLimitError);

    expect(spotify.getCooldown()).toEqual({
      kind: "quota",
      retryAt: null,
      detail: "Too many requests",
    });
  });
});
