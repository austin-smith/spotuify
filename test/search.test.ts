import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import { PER_TYPE, search } from "../src/api/search.ts";
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

  test("caps each type at its display budget", async () => {
    stub({ tracks: { items: Array.from({ length: 10 }, (_, i) => track(`t${i}`)) } });
    const results = await search(new SpotifyClient(tokens), "q");
    expect(results.tracks).toHaveLength(PER_TYPE.tracks);
  });

  // limit=20 is a hard 400 from Spotify, not a silent clamp.
  test("never requests a limit above 10", async () => {
    const { urls } = stub({});
    await search(new SpotifyClient(tokens), "q");
    const limit = Number(new URL(urls[0]!).searchParams.get("limit"));
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(10);
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

  test("handles a 204 with no body", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;
    const results = await search(new SpotifyClient(tokens), "q");
    expect(results.tracks).toEqual([]);
  });
});
