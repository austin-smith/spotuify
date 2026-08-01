import { afterEach, describe, expect, test } from "bun:test";
import {
  audiobookChapters,
  audiobookDetails,
  showDetails,
  showEpisodes,
} from "../src/api/catalog.ts";
import { SpotifyClient } from "../src/api/client.ts";
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

function stub(body: unknown): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json(body);
  }) as unknown as typeof fetch;
  return { urls };
}

describe("showEpisodes", () => {
  test("asks for one page of fifty and drops null entries", async () => {
    const { urls } = stub({
      items: [
        { id: "e", name: "Ep", uri: "spotify:episode:e", duration_ms: 1000 },
        null,
      ],
      next: "ignored",
    });
    const episodes = await showEpisodes(new SpotifyClient(tokens), "show1");
    const parsed = new URL(urls[0]!);
    expect(parsed.pathname).toContain("/shows/show1/episodes");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(episodes.map((e) => e.name)).toEqual(["Ep"]);
    expect(urls).toHaveLength(1);
  });
});

describe("show and audiobook details", () => {
  test("reads the show itself", async () => {
    const { urls } = stub({ id: "s", name: "Show", uri: "spotify:show:s", publisher: "P" });
    const show = await showDetails(new SpotifyClient(tokens), "s");
    expect(new URL(urls[0]!).pathname).toContain("/shows/s");
    expect(show.publisher).toBe("P");
  });

  test("reads the audiobook and its chapters", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname.replace("/v1", "");
      requested.push(path);
      return Response.json(
        path.endsWith("/chapters")
          ? {
              items: [
                {
                  id: "c",
                  name: "Chapter 1",
                  uri: "spotify:episode:c",
                  duration_ms: 1000,
                  chapter_number: 1,
                },
              ],
            }
          : { id: "b", name: "Book", uri: "spotify:audiobook:b" },
      );
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(tokens);
    const book = await audiobookDetails(spotify, "b");
    const chapters = await audiobookChapters(spotify, "b");
    expect(requested).toEqual(["/audiobooks/b", "/audiobooks/b/chapters"]);
    expect(book.name).toBe("Book");
    expect(chapters.map((c) => c.chapter_number)).toEqual([1]);
  });

  test("refuses an empty details response", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(showDetails(new SpotifyClient(tokens), "s")).rejects.toThrow(
      "no show",
    );
  });
});
