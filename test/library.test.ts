import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient, SpotifyLimitError } from "../src/api/client.ts";
import { fetchHome } from "../src/api/library.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { toHomeRows } from "../src/store/rows.ts";

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

const track = (name: string, id = name) => ({
  id,
  name,
  uri: `spotify:track:${id}`,
  duration_ms: 200_000,
  artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
  album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
});

/** Route each endpoint to a canned response, or an HTTP status to simulate a restriction. */
function routes(map: Record<string, unknown | number>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname.replace("/v1", "");
    calls.push(path);
    const entry = map[path];
    if (entry === undefined) return new Response("{}", { status: 200 });
    if (typeof entry === "number") return new Response("nope", { status: entry });
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("fetchHome", () => {
  test("unwraps each endpoint's own shape", async () => {
    routes({
      "/me/player/recently-played": { items: [{ track: track("Recent") }] },
      "/me/top/tracks": { items: [track("Top")] },
    });

    const home = await fetchHome(new SpotifyClient(tokens));
    expect(home.recent.map((t) => t.name)).toEqual(["Recent"]);
    expect(home.top.map((t) => t.name)).toEqual(["Top"]);
  });

  // Some of these endpoints are restricted per app/account; one 403 must not blank the screen.
  test("a failing group costs only that group", async () => {
    routes({
      "/me/player/recently-played": 403,
      "/me/top/tracks": { items: [track("Top")] },
    });

    const home = await fetchHome(new SpotifyClient(tokens));
    expect(home.recent).toEqual([]);
    expect(home.top.map((t) => t.name)).toEqual(["Top"]);
  });

  // Recently-played repeats the same track constantly.
  test("dedupes recently played", async () => {
    routes({
      "/me/player/recently-played": {
        items: [
          { track: track("Same", "1") },
          { track: track("Same", "1") },
          { track: track("Other", "2") },
          { track: track("Same", "1") },
        ],
      },
    });

    const home = await fetchHome(new SpotifyClient(tokens));
    expect(home.recent.map((t) => t.name)).toEqual(["Same", "Other"]);
  });

  test("drops null items", async () => {
    routes({
      "/me/player/recently-played": { items: [{ track: null }, { track: track("Real") }] },
      "/me/top/tracks": { items: [null, track("Top")] },
    });

    const home = await fetchHome(new SpotifyClient(tokens));
    expect(home.recent.map((t) => t.name)).toEqual(["Real"]);
    expect(home.top.map((t) => t.name)).toEqual(["Top"]);
  });

  test("survives every endpoint failing", async () => {
    routes({
      "/me/player/recently-played": 500,
      "/me/top/tracks": 500,
    });
    const home = await fetchHome(new SpotifyClient(tokens));
    expect(home).toEqual({ recent: [], top: [], playlists: [] });
  });

  test("keeps a rate-limited home retryable instead of returning a cacheable empty result", async () => {
    let now = 10_000;
    let requests = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      requests++;
      if (requests === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Too many requests" } }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "1",
            },
          },
        );
      }

      const path = new URL(String(url)).pathname.replace("/v1", "");
      const body =
        path === "/me/player/recently-played"
          ? { items: [{ track: track("Recovered") }] }
          : { items: [], next: null };
      return Response.json(body);
    }) as unknown as typeof fetch;

    const client = new SpotifyClient(tokens, { now: () => now });
    await expect(fetchHome(client, { meId: "me" })).rejects.toBeInstanceOf(
      SpotifyLimitError,
    );
    // The first response opens the shared circuit; the other home groups are blocked locally.
    expect(requests).toBe(1);

    now += 1_000;
    const recovered = await fetchHome(client, { meId: "me" });
    expect(recovered.recent.map((item) => item.name)).toEqual(["Recovered"]);
    expect(requests).toBe(4);
  });

  test("loads playlists without issuing one request per playlist", async () => {
    const calls = routes({
      "/me/player/recently-played": { items: [] },
      "/me/top/tracks": { items: [] },
      "/me/playlists": {
        items: [
          {
            id: "one",
            name: "One",
            uri: "spotify:playlist:one",
            owner: { id: "me", display_name: "Me" },
          },
          {
            id: "two",
            name: "Two",
            uri: "spotify:playlist:two",
            owner: { id: "me", display_name: "Me" },
          },
        ],
        next: null,
      },
    });

    const home = await fetchHome(new SpotifyClient(tokens), { meId: "me" });
    expect(home.playlists.map((playlist) => playlist.name)).toEqual(["One", "Two"]);
    expect(calls.filter((path) => path === "/me/playlists")).toHaveLength(1);
    expect(calls.some((path) => path.startsWith("/playlists/"))).toBe(false);
  });
});

describe("toHomeRows", () => {
  test("labels each group and omits empty ones", () => {
    const rows = toHomeRows({ recent: [track("R")], top: [], playlists: [] });
    const headers = rows
      .filter((r) => r.kind === "header")
      .map((r) => (r as { label: string }).label);
    expect(headers).toEqual(["RECENTLY PLAYED"]);
  });

  test("lists both groups when both have items", () => {
    const rows = toHomeRows({ recent: [track("R")], top: [track("T")], playlists: [] });
    const headers = rows
      .filter((r) => r.kind === "header")
      .map((r) => (r as { label: string }).label);
    expect(headers).toEqual(["RECENTLY PLAYED", "YOUR TOP TRACKS"]);
  });

  test("is empty when nothing loaded", () => {
    expect(toHomeRows({ recent: [], top: [], playlists: [] })).toEqual([]);
  });

  test("tracks play by uri", () => {
    const rows = toHomeRows({ recent: [track("R")], top: [], playlists: [] });
    const results = rows.filter((r) => r.kind === "result");
    expect(results[0]).toMatchObject({ play: { uris: ["spotify:track:R"] } });
  });
});
