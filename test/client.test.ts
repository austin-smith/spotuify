import { afterEach, describe, expect, test } from "bun:test";
import {
  PlayerCommandRejectedError,
  PremiumRequiredError,
  SpotifyApiError,
  SpotifyClient,
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
