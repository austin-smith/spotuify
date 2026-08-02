import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { usePlaylistCatalog } from "../src/store/playlists.ts";
import { useSearch } from "../src/store/search.ts";

const realFetch = globalThis.fetch;
const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

const track = (index: number) => ({
  id: `track-${index}`,
  name: `Track ${index}`,
  uri: `spotify:track:track-${index}`,
  duration_ms: 1_000,
  artists: [],
  album: { id: "album", name: "Album", uri: "spotify:album:album", images: [] },
});

const album = (index: number) => ({
  id: `album-${index}`,
  name: `Album ${index}`,
  uri: `spotify:album:album-${index}`,
  images: [],
});

const ownedPlaylist = {
  id: "playlist",
  name: "Query favorites",
  uri: "spotify:playlist:playlist",
  owner: { id: "me", display_name: "Me" },
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function eventually(assertion: () => void, timeout = 1_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await Bun.sleep(10);
    }
  }
  throw failure;
}

afterEach(() => {
  useSearch.getState().closePalette();
  globalThis.fetch = realFetch;
});

describe("search store", () => {
  test("keeps scope separate from query and sends one scoped request", async () => {
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/search")) {
        return response({
          albums: {
            items: [{ id: "a", name: "Album", uri: "spotify:album:a", images: [] }],
            total: 1,
            limit: 10,
            offset: 0,
            next: null,
          },
        });
      }
      return response({ items: [], next: null });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setScope("album");
    useSearch.getState().setQuery("motion sickness");

    await eventually(() => expect(useSearch.getState().current()?.label).toBe("Album"));
    const request = requests.find((url) => url.pathname.endsWith("/search"));
    expect(request?.searchParams.get("q")).toBe("motion sickness");
    expect(request?.searchParams.get("type")).toBe("album");
    expect(request?.searchParams.get("limit")).toBe("10");
    expect(useSearch.getState()).toMatchObject({ scope: "album", query: "motion sickness" });
  });

  test("never leaks local playlist matches into a non-playlist scope", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search")) {
        return response({
          tracks: {
            items: [track(1)],
            total: 1,
            limit: 10,
            offset: 0,
            next: null,
          },
        });
      }
      if (url.pathname.endsWith("/me/playlists")) {
        return response({ items: [ownedPlaylist], next: null });
      }
      return response({ items: [], next: null });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setScope("track");
    useSearch.getState().setQuery("query");

    await eventually(() => expect(useSearch.getState().current()?.label).toBe("Track 1"));
    await eventually(() => expect(usePlaylistCatalog.getState().loaded).toBeTrue());
    expect(useSearch.getState().rows().some((row) => row.label === ownedPlaylist.name)).toBeFalse();
  });

  test("keeps local playlist matches when an eligible Spotify search has no body", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/me/playlists")) {
        return response({ items: [ownedPlaylist], next: null });
      }
      return response({ items: [], next: null });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setQuery("query");

    await eventually(() => expect(usePlaylistCatalog.getState().loaded).toBeTrue());
    await eventually(() => expect(useSearch.getState().current()?.label).toBe(ownedPlaylist.name));
  });

  test("reruns the unchanged query when the visible scope changes", async () => {
    const searchRequests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/search")) return response({ items: [], next: null });
      searchRequests.push(url);
      return response({
        albums: {
          items: [{ id: "a", name: "Album", uri: "spotify:album:a", images: [] }],
          total: 1,
          limit: 10,
          offset: 0,
          next: null,
        },
      });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setQuery("motion sickness");
    await eventually(() => expect(searchRequests).toHaveLength(1));

    useSearch.getState().setScope("album");
    await eventually(() => expect(searchRequests).toHaveLength(2));

    expect(searchRequests[0]?.searchParams.get("type")).toBe(
      "track,artist,album,playlist",
    );
    expect(searchRequests[1]?.searchParams.get("type")).toBe("album");
    expect(useSearch.getState().query).toBe("motion sickness");
  });

  test("loads the next ten for only the activated category and appends in place", async () => {
    const searchRequests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/search")) return response({ items: [], next: null });
      searchRequests.push(url);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return response({
        tracks: {
          items: Array.from({ length: 10 }, (_, index) => track(offset + index)),
          total: 25,
          limit: 10,
          offset,
          next: offset + 10 < 25 ? "next" : null,
        },
      });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setScope("track");
    useSearch.getState().setQuery("query");
    await eventually(() => expect(useSearch.getState().rows()).toHaveLength(12));

    useSearch.getState().moveTo("last");
    expect(useSearch.getState().currentRow()).toMatchObject({
      kind: "more",
      category: "tracks",
    });
    useSearch.getState().loadMore("tracks");

    await eventually(() => {
      const resultRows = useSearch.getState().rows().filter((row) => row.kind === "result");
      expect(resultRows).toHaveLength(20);
    });
    expect(searchRequests).toHaveLength(2);
    expect(searchRequests[1]?.searchParams.get("type")).toBe("track");
    expect(searchRequests[1]?.searchParams.get("offset")).toBe("10");
    expect(useSearch.getState().current()?.label).toBe("Track 10");
  });

  test("preserves another category's selected load-more row during concurrent pagination", async () => {
    let resolveTracks: ((response: Response) => void) | null = null;
    let resolveAlbums: ((response: Response) => void) | null = null;
    const tracksPage = new Promise<Response>((resolve) => { resolveTracks = resolve; });
    const albumsPage = new Promise<Response>((resolve) => { resolveAlbums = resolve; });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/search")) return response({ items: [], next: null });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const type = url.searchParams.get("type");
      if (offset === 10 && type === "track") return await tracksPage;
      if (offset === 10 && type === "album") return await albumsPage;
      return response({
        tracks: {
          items: Array.from({ length: 10 }, (_, index) => track(index)),
          total: 20,
          limit: 10,
          offset: 0,
          next: "next-tracks",
        },
        albums: {
          items: Array.from({ length: 10 }, (_, index) => album(index)),
          total: 20,
          limit: 10,
          offset: 0,
          next: "next-albums",
        },
      });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setQuery("query");
    await eventually(() => {
      expect(
        useSearch.getState().rows().filter((row) => row.kind === "more"),
      ).toHaveLength(2);
    });

    useSearch.getState().loadMore("tracks");
    useSearch.getState().moveTo("last");
    expect(useSearch.getState().currentRow()).toMatchObject({
      kind: "more",
      category: "albums",
    });
    useSearch.getState().loadMore("albums");

    await eventually(() => {
      expect(resolveTracks).not.toBeNull();
      expect(resolveAlbums).not.toBeNull();
    });
    resolveTracks!(response({
      tracks: {
        items: Array.from({ length: 10 }, (_, index) => track(index + 10)),
        total: 20,
        limit: 10,
        offset: 10,
        next: null,
      },
    }));
    await eventually(() => {
      expect(useSearch.getState().currentRow()).toMatchObject({
        kind: "more",
        category: "albums",
      });
    });

    resolveAlbums!(response({
      albums: {
        items: Array.from({ length: 10 }, (_, index) => album(index + 10)),
        total: 20,
        limit: 10,
        offset: 10,
        next: null,
      },
    }));
    await eventually(() => expect(useSearch.getState().current()?.label).toBe("Album 10"));
  });

  test("keeps loaded results and turns a failed page into an inline retry", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/search")) return response({ items: [], next: null });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset === 10) {
        return new Response(JSON.stringify({ error: { status: 500, message: "page failed" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return response({
        tracks: {
          items: Array.from({ length: 10 }, (_, index) => track(index)),
          total: 20,
          limit: 10,
          offset: 0,
          next: "next",
        },
      });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setScope("track");
    useSearch.getState().setQuery("query");
    await eventually(() => expect(useSearch.getState().rows()).toHaveLength(12));

    useSearch.getState().loadMore("tracks");
    await eventually(() => {
      expect(useSearch.getState().rows().filter((row) => row.kind === "result")).toHaveLength(10);
      expect(
        useSearch.getState().rows().some(
          (row) => row.kind === "more" && row.label === "↻ retry loading tracks" && row.error,
        ),
      ).toBeTrue();
    });
  });

  test("finishes pagination when Spotify returns no content for the next page", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/search")) return response({ items: [], next: null });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset === 10) return new Response(null, { status: 204 });
      return response({
        tracks: {
          items: Array.from({ length: 10 }, (_, index) => track(index)),
          total: 20,
          limit: 10,
          offset: 0,
          next: "next",
        },
      });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setScope("track");
    useSearch.getState().setQuery("query");
    await eventually(() => expect(useSearch.getState().rows()).toHaveLength(12));

    useSearch.getState().loadMore("tracks");
    await eventually(() => {
      expect(useSearch.getState().rows().filter((row) => row.kind === "result")).toHaveLength(10);
      expect(useSearch.getState().rows().some((row) => row.kind === "more")).toBeFalse();
    });
  });

  test("turns an exact Spotify reference into a confirmable result without searching", async () => {
    const paths: string[] = [];
    const id = "4uLU6hMCjMI75M1A2tKUQC";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith(`/tracks/${id}`)) {
        return response({ ...track(1), id, uri: `spotify:track:${id}` });
      }
      return response({ items: [], next: null });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setQuery(`https://open.spotify.com/track/${id}?si=tracking`);

    await eventually(() => expect(useSearch.getState().current()?.label).toBe("Track 1"));
    expect(paths.some((path) => path.endsWith("/search"))).toBeFalse();
    expect(useSearch.getState().showingReference).toBeTrue();
    expect(useSearch.getState().current()?.referenceUri).toBe(`spotify:track:${id}`);
  });

  test("presents a direct-reference failure without API endpoint internals", async () => {
    const id = "4uLU6hMCjMI75M1A2tKUQC";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/tracks/${id}`)) {
        return new Response(
          JSON.stringify({ error: { status: 404, message: "Resource not found" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return response({ items: [], next: null });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setQuery(`spotify:track:${id}`);

    await eventually(() => {
      expect(useSearch.getState().error).toBe(
        "Couldn’t load this item · Resource not found (404)",
      );
    });
    expect(useSearch.getState().error).not.toContain(`/tracks/${id}`);
    expect(useSearch.getState().error).not.toContain("Spotify API");
  });

  test("keeps catalog scope controls out of direct-reference mode", async () => {
    const id = "4uLU6hMCjMI75M1A2tKUQC";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/tracks/${id}`)) {
        return response({ ...track(1), id, uri: `spotify:track:${id}` });
      }
      return response({ items: [], next: null });
    }) as typeof fetch;

    useSearch.getState().configure(new SpotifyClient(tokens), "US", "me");
    useSearch.getState().openPalette();
    useSearch.getState().setScope("album");
    useSearch.getState().setQuery(`spotify:track:${id}`);
    await eventually(() => expect(useSearch.getState().showingReference).toBeTrue());

    useSearch.getState().setScope("track");
    expect(useSearch.getState()).toMatchObject({ scope: "album" });
  });
});
