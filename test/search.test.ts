import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import { SEARCH_PAGE_SIZE, search } from "../src/api/search.ts";
import type { TokenStore } from "../src/auth/tokens.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A TokenStore stand-in; the client only ever asks it for a bearer string. */
const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

function stub(body: unknown): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { urls };
}

const track = (name: string) => ({
  id: name,
  name,
  uri: `spotify:track:${name}`,
  duration_ms: 1000,
  artists: [],
  album: { id: "a", name: "A", uri: "spotify:album:a", images: [] },
});

describe("search", () => {
  test("returns empty results for a blank query without calling the API", async () => {
    const { urls } = stub({});
    const results = await search(new SpotifyClient(tokens), "   ");
    expect(results.tracks).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  // Spotify returns null entries inside these arrays; anything reading `.name` would crash.
  test("drops null entries", async () => {
    stub({
      tracks: { items: [track("One"), null, track("Two")] },
      playlists: { items: [null, { id: "p", name: "P", uri: "spotify:playlist:p" }, null] },
    });
    const results = await search(new SpotifyClient(tokens), "q");
    expect(results.tracks.map((t) => t.name)).toEqual(["One", "Two"]);
    expect(results.playlists.map((p) => p.name)).toEqual(["P"]);
  });

  test("tolerates missing type keys entirely", async () => {
    stub({ tracks: { items: [track("One")] } });
    const results = await search(new SpotifyClient(tokens), "q");
    expect(results.artists).toEqual([]);
    expect(results.albums).toEqual([]);
    expect(results.playlists).toEqual([]);
  });

  test("uses one consistent ten-result page for every type", async () => {
    stub({ tracks: { items: Array.from({ length: 15 }, (_, i) => track(`t${i}`)) } });
    const results = await search(new SpotifyClient(tokens), "q");
    expect(results.tracks).toHaveLength(SEARCH_PAGE_SIZE);
  });

  // limit=20 is a hard 400 from Spotify, not a silent clamp.
  test("never requests a limit above 10", async () => {
    const { urls } = stub({});
    await search(new SpotifyClient(tokens), "q");
    const limit = Number(new URL(urls[0]!).searchParams.get("limit"));
    expect(limit).toBe(10);
  });

  test("requests all four types and passes the market", async () => {
    const { urls } = stub({});
    await search(new SpotifyClient(tokens), "q", { market: "US" });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("type")).toBe("track,artist,album,playlist");
    expect(params.get("market")).toBe("US");
    expect(params.get("q")).toBe("q");
  });

  test("trims the query", async () => {
    const { urls } = stub({});
    await search(new SpotifyClient(tokens), "  oliver tree  ");
    expect(new URL(urls[0]!).searchParams.get("q")).toBe("oliver tree");
  });

  test("requests only the selected scope", async () => {
    const { urls } = stub({});
    await search(new SpotifyClient(tokens), "q", { scope: "album" });
    expect(new URL(urls[0]!).searchParams.get("type")).toBe("album");
  });

  test("requests only categories compatible with official field filters", async () => {
    const { urls } = stub({});
    await search(new SpotifyClient(tokens), "genre:ambient");
    expect(new URL(urls[0]!).searchParams.get("type")).toBe("track,artist");
  });

  test("carries totals and the next offset for each requested category", async () => {
    stub({
      tracks: {
        items: Array.from({ length: 10 }, (_, i) => track(`t${i}`)),
        total: 284,
        limit: 10,
        offset: 20,
        next: "next-page",
      },
    });
    const results = await search(new SpotifyClient(tokens), "q", {
      scope: "track",
      offset: 20,
    });
    expect(results.pages?.tracks).toEqual({ loaded: 10, total: 284, nextOffset: 30 });
  });

  test("stops pagination at Spotify's maximum search offset", async () => {
    stub({
      tracks: {
        items: Array.from({ length: 10 }, (_, i) => track(`t${i}`)),
        total: 2_000,
        limit: 10,
        offset: 1_000,
        next: "unrequestable-page",
      },
    });
    const results = await search(new SpotifyClient(tokens), "q", {
      scope: "track",
      offset: 1_000,
    });
    expect(results.pages?.tracks?.nextOffset).toBeNull();
  });

  test("handles a 204 with no body", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;
    const results = await search(new SpotifyClient(tokens), "q");
    expect(results.tracks).toEqual([]);
  });

  test("requests only the caller's types", async () => {
    const { urls } = stub({});
    const results = await search(new SpotifyClient(tokens), "q", {
      types: ["episode", "show"],
    });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("type")).toBe("episode,show");
    expect(params.get("limit")).toBe("10");
    expect(results).not.toHaveProperty("pages");
  });

  test("rejects mixing palette pagination with explicit CLI result controls", async () => {
    const { urls } = stub({});
    await expect(
      search(new SpotifyClient(tokens), "q", {
        scope: "track",
        types: ["track"],
      }),
    ).rejects.toThrow("cannot be combined");
    expect(urls).toHaveLength(0);
  });

  test("returns episodes, shows, and audiobooks when asked", async () => {
    stub({
      episodes: {
        items: [
          { id: "e", name: "Ep", uri: "spotify:episode:e", duration_ms: 1000 },
        ],
        next: null,
      },
      shows: {
        items: [{ id: "s", name: "Show", uri: "spotify:show:s", publisher: "P" }],
        next: null,
      },
      audiobooks: {
        items: [{ id: "b", name: "Book", uri: "spotify:audiobook:b" }],
        next: null,
      },
    });
    const results = await search(new SpotifyClient(tokens), "q", {
      types: ["episode", "show", "audiobook"],
    });
    expect(results.episodes.map((e) => e.name)).toEqual(["Ep"]);
    expect(results.shows.map((s) => s.name)).toEqual(["Show"]);
    expect(results.audiobooks.map((b) => b.name)).toEqual(["Book"]);
  });

  /**
   * The 10-per-request cap is Spotify's, not ours. Deeper limits page by offset, and each request
   * asks only for what is still missing so the final page never over-fetches past the cap.
   */
  test("pages by offset to satisfy limits above one request", async () => {
    const requests: URLSearchParams[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const params = new URL(String(url)).searchParams;
      requests.push(params);
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit"));
      return Response.json({
        tracks: {
          items: Array.from({ length: limit }, (_, i) => track(`t${offset + i}`)),
          next: "next-page",
        },
      });
    }) as unknown as typeof fetch;

    const results = await search(new SpotifyClient(tokens), "q", {
      types: ["track"],
      limit: 25,
    });
    expect(results.tracks).toHaveLength(25);
    expect(results.tracks.map((t) => t.name)).toEqual(
      Array.from({ length: 25 }, (_, i) => `t${i}`),
    );
    expect(requests.map((p) => [p.get("offset"), p.get("limit")])).toEqual([
      [null, "10"],
      ["10", "10"],
      ["20", "5"],
    ]);
  });

  test("stops paging when Spotify reports no further page", async () => {
    const { urls } = stub({ tracks: { items: [track("only")], next: null } });
    const results = await search(new SpotifyClient(tokens), "q", {
      types: ["track"],
      limit: 30,
    });
    expect(results.tracks.map((t) => t.name)).toEqual(["only"]);
    expect(urls).toHaveLength(1);
  });

  test("rejects limits outside Spotify's reachable range", async () => {
    const { urls } = stub({});
    await expect(
      search(new SpotifyClient(tokens), "q", { types: ["track"], limit: 51 }),
    ).rejects.toThrow("between 1 and 50");
    await expect(
      search(new SpotifyClient(tokens), "q", { types: ["track"], limit: 0 }),
    ).rejects.toThrow("between 1 and 50");
    expect(urls).toHaveLength(0);
  });
});
