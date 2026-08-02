import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import { followedArtists } from "../src/api/follow.ts";
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

const artist = (id: string) => ({
  id,
  name: id,
  uri: `spotify:artist:${id}`,
  genres: ["indie"],
  followers: { total: 10 },
});

// Follow mutations and membership checks go through the URI-based `/me/library` family and are
// covered by the library tests; listing is the only follow-specific request.
describe("followedArtists", () => {
  test("walks the cursor until Spotify stops providing one", async () => {
    const calls: URLSearchParams[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const params = new URL(String(url)).searchParams;
      calls.push(params);
      return Response.json(
        params.get("after") === null
          ? { artists: { items: [artist("a1")], cursors: { after: "a1" } } }
          : { artists: { items: [artist("a2")], cursors: { after: null } } },
      );
    }) as unknown as typeof fetch;

    const artists = await followedArtists(new SpotifyClient(tokens));
    expect(artists.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(calls.map((c) => c.get("after"))).toEqual([null, "a1"]);
    expect(calls.every((c) => c.get("type") === "artist")).toBe(true);
  });

  test("drops null entries and survives a missing cursor object", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        artists: { items: [null, artist("a1"), null] },
      })) as unknown as typeof fetch;
    const artists = await followedArtists(new SpotifyClient(tokens));
    expect(artists.map((a) => a.id)).toEqual(["a1"]);
  });
});
