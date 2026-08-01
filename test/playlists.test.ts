import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import {
  addPlaylistItems,
  createPlaylist,
  movePlaylistItems,
  myPlaylists,
  playlistItems,
  removePlaylistItems,
  replacePlaylistItems,
  updatePlaylistDetails,
} from "../src/api/playlists.ts";
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

interface Call {
  path: string;
  query: URLSearchParams;
}

/**
 * Serve a canned response per path and record what was asked for.
 *
 * The recorded calls matter as much as the responses: this module exists because Spotify moved the
 * endpoint, so a test that passes while requesting the dead one is worthless.
 */
function serve(map: Record<string, unknown | number>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v1", "");
    calls.push({ path, query: parsed.searchParams });

    const entry = map[path];
    if (entry === undefined) return new Response("nope", { status: 404 });
    if (typeof entry === "number") return new Response("nope", { status: entry });
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const track = (name: string) => ({
  id: name,
  name,
  uri: `spotify:track:${name}`,
  duration_ms: 200_000,
  type: "track",
  artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
  album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
});

describe("playlistItems", () => {
  test("asks /items, never the retired /tracks", async () => {
    const calls = serve({ "/playlists/p/items": { items: [{ item: track("One") }], next: null } });
    await playlistItems(new SpotifyClient(tokens), "p");
    expect(calls[0]?.path).toBe("/playlists/p/items");
    expect(calls.some((c) => c.path.endsWith("/tracks"))).toBe(false);
  });

  test("reads the current `item` key", async () => {
    serve({ "/playlists/p/items": { items: [{ item: track("One") }], next: null } });
    const entries = await playlistItems(new SpotifyClient(tokens), "p");
    expect(entries.map((e) => e.track.name)).toEqual(["One"]);
  });

  // Older responses used `track`; it costs one line to keep reading it.
  test("falls back to the deprecated `track` key", async () => {
    serve({ "/playlists/p/items": { items: [{ track: track("Old") }], next: null } });
    const entries = await playlistItems(new SpotifyClient(tokens), "p");
    expect(entries.map((e) => e.track.name)).toEqual(["Old"]);
  });

  /**
   * The reason `position` exists at all. Playing a row starts the playlist at an offset, so an entry
   * dropped here must still consume its slot — otherwise choosing the row after a podcast starts the
   * wrong song.
   */
  test("keeps positions when entries are skipped", async () => {
    serve({
      "/playlists/p/items": {
        items: [
          { item: track("One") },
          { item: { ...track("Ep"), type: "episode" } },
          { item: null },
          { item: track("Four") },
        ],
        next: null,
      },
    });

    const entries = await playlistItems(new SpotifyClient(tokens), "p");
    expect(entries.map((e) => e.track.name)).toEqual(["One", "Four"]);
    expect(entries.map((e) => e.position)).toEqual([0, 3]);
  });

  test("follows pages and keeps positions across them", async () => {
    let page = 0;
    globalThis.fetch = (async () => {
      page++;
      const body =
        page === 1
          ? { items: Array.from({ length: 50 }, (_, i) => ({ item: track(`a${i}`) })), next: "u" }
          : { items: [{ item: track("last") }], next: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const entries = await playlistItems(new SpotifyClient(tokens), "p");
    expect(entries).toHaveLength(51);
    expect(entries.at(-1)?.position).toBe(50);
  });

  test("continues past 600 items", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset") ?? "0");
      const lastPage = offset === 600;
      return new Response(
        JSON.stringify({
          items: lastPage
            ? [{ item: track("last") }]
            : Array.from({ length: 50 }, (_, index) => ({
                item: track(`${offset + index}`),
              })),
          next: lastPage ? null : "next",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const entries = await playlistItems(new SpotifyClient(tokens), "p");
    expect(entries).toHaveLength(601);
    expect(entries.at(-1)?.position).toBe(600);
  });

  test("stops when a page reports no next", async () => {
    const calls = serve({ "/playlists/p/items": { items: [{ item: track("One") }], next: null } });
    await playlistItems(new SpotifyClient(tokens), "p");
    expect(calls).toHaveLength(1);
  });

  test("requests only the fields the rows read", async () => {
    const calls = serve({ "/playlists/p/items": { items: [], next: null } });
    await playlistItems(new SpotifyClient(tokens), "p");
    expect(calls[0]?.query.get("fields")).toContain("duration_ms");
    expect(calls[0]?.query.get("limit")).toBe("50");
  });

  // Spotify answers 403 for every playlist the user does not own, which is the single most likely
  // failure here and says nothing useful on its own.
  test("explains a 403 in terms of ownership", async () => {
    serve({ "/playlists/p/items": 403 });
    await expect(playlistItems(new SpotifyClient(tokens), "p")).rejects.toThrow(
      "spotify only opens playlists you own",
    );
  });

  test("explains a 404 without naming an endpoint", async () => {
    serve({ "/playlists/p/items": 404 });
    await expect(playlistItems(new SpotifyClient(tokens), "p")).rejects.toThrow(
      "spotify no longer exposes this playlist",
    );
  });
});

describe("myPlaylists", () => {
  const raw = (id: string, ownerId: string) => ({
    id,
    name: `List ${id}`,
    uri: `spotify:playlist:${id}`,
    owner: { id: ownerId, display_name: ownerId },
  });

  test("marks only the user's own as openable", async () => {
    serve({ "/me/playlists": { items: [raw("a", "me"), raw("b", "someone")], next: null } });
    const lists = await myPlaylists(new SpotifyClient(tokens), "me");
    expect(lists.map((p) => p.mine)).toEqual([true, false]);
    expect(lists[1]?.ownerName).toBe("someone");
  });

  // A followed playlist is still in the user's library and still playable; only opening it fails.
  test("keeps playlists owned by others", async () => {
    serve({ "/me/playlists": { items: [raw("b", "someone")], next: null } });
    const lists = await myPlaylists(new SpotifyClient(tokens), "me");
    expect(lists).toHaveLength(1);
  });

  test("drops null entries", async () => {
    serve({ "/me/playlists": { items: [null, raw("a", "me")], next: null } });
    const lists = await myPlaylists(new SpotifyClient(tokens), "me");
    expect(lists.map((p) => p.id)).toEqual(["a"]);
  });

  test("never claims ownership when the owner is unknown", async () => {
    serve({ "/me/playlists": { items: [{ id: "x", name: "X", uri: "u" }], next: null } });
    const lists = await myPlaylists(new SpotifyClient(tokens), "");
    expect(lists[0]?.mine).toBe(false);
  });

  test("continues past 200 playlists", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const offset = Number(new URL(String(url)).searchParams.get("offset") ?? "0");
      const lastPage = offset === 200;
      const items = lastPage
        ? [raw("last", "me")]
        : Array.from({ length: 50 }, (_, index) => raw(`${offset + index}`, "me"));
      return new Response(
        JSON.stringify({ items, next: lastPage ? null : "next" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const lists = await myPlaylists(new SpotifyClient(tokens), "me");
    expect(lists).toHaveLength(201);
    expect(lists.at(-1)?.id).toBe("last");
  });
});

describe("addPlaylistItems", () => {
  test("posts URI items to the current /items endpoint and returns its snapshot", async () => {
    let call:
      | { method: string | undefined; path: string; body: unknown }
      | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      call = {
        method: init?.method,
        path: new URL(String(input)).pathname.replace("/v1", ""),
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ snapshot_id: "snapshot-1" }, { status: 201 });
    }) as unknown as typeof fetch;

    const snapshot = await addPlaylistItems(new SpotifyClient(tokens), "owned", [
      "spotify:track:one",
    ]);

    expect(snapshot).toBe("snapshot-1");
    expect(call).toEqual({
      method: "POST",
      path: "/playlists/owned/items",
      body: { uris: ["spotify:track:one"] },
    });
  });

  test("requires Spotify's confirmation instead of assuming a successful write", async () => {
    globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
    await expect(
      addPlaylistItems(new SpotifyClient(tokens), "owned", ["spotify:track:one"]),
    ).rejects.toThrow("did not confirm");
  });

  test("enforces the documented 100-item request limit before the network", async () => {
    let requested = false;
    globalThis.fetch = (async () => {
      requested = true;
      return Response.json({ snapshot_id: "unexpected" });
    }) as unknown as typeof fetch;

    await expect(
      addPlaylistItems(
        new SpotifyClient(tokens),
        "owned",
        Array.from({ length: 101 }, (_, index) => `spotify:track:${index}`),
      ),
    ).rejects.toThrow("at most 100");
    expect(requested).toBe(false);
  });
});

describe("playlist management", () => {
  test("creates playlists on the current /me route", async () => {
    let request: { path: string; method: string | undefined; body: unknown } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = {
        path: new URL(String(input)).pathname.replace("/v1", ""),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({
        id: "p",
        name: "Road trip",
        uri: "spotify:playlist:p",
        public: false,
        collaborative: true,
        description: "Drive",
        snapshot_id: "s1",
      }, { status: 201 });
    }) as unknown as typeof fetch;
    const created = await createPlaylist(new SpotifyClient(tokens), {
      name: "Road trip",
      public: false,
      collaborative: true,
      description: "Drive",
    });
    expect(request).toEqual({
      path: "/me/playlists",
      method: "POST",
      body: { name: "Road trip", public: false, collaborative: true, description: "Drive" },
    });
    expect(created.snapshotId).toBe("s1");
  });

  test("rejects an impossible public collaborative playlist locally", async () => {
    await expect(
      createPlaylist(new SpotifyClient(tokens), {
        name: "Nope",
        public: true,
        collaborative: true,
      }),
    ).rejects.toThrow("must be private");
  });

  test("makes collaborative playlist creation explicitly private by default", async () => {
    let body: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: "p",
        name: "Shared",
        uri: "spotify:playlist:p",
        public: false,
        collaborative: true,
        description: null,
        snapshot_id: "s1",
      });
    }) as unknown as typeof fetch;

    await createPlaylist(new SpotifyClient(tokens), {
      name: "Shared",
      collaborative: true,
    });
    expect(body).toEqual({
      name: "Shared",
      public: false,
      collaborative: true,
    });
  });

  test("updates details without sending omitted fields", async () => {
    let body: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await updatePlaylistDetails(new SpotifyClient(tokens), "p", { description: "New" });
    expect(body).toEqual({ description: "New" });
  });

  test("removes items using the current /items body and snapshot", async () => {
    let request: { path: string; method: string | undefined; body: unknown } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request = {
        path: new URL(String(input)).pathname.replace("/v1", ""),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ snapshot_id: "s2" });
    }) as unknown as typeof fetch;
    expect(
      await removePlaylistItems(
        new SpotifyClient(tokens),
        "p",
        ["spotify:track:a"],
        "s1",
      ),
    ).toBe("s2");
    expect(request).toEqual({
      path: "/playlists/p/items",
      method: "DELETE",
      body: { items: [{ uri: "spotify:track:a" }], snapshot_id: "s1" },
    });
  });

  test("reorders a contiguous range without replacing playlist items", async () => {
    let body: unknown;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ snapshot_id: "s3" });
    }) as unknown as typeof fetch;
    expect(
      await movePlaylistItems(new SpotifyClient(tokens), "p", {
        from: 4,
        before: 1,
        length: 2,
        snapshotId: "s2",
      }),
    ).toBe("s3");
    expect(body).toEqual({
      range_start: 4,
      insert_before: 1,
      range_length: 2,
      snapshot_id: "s2",
    });
  });

  test("replaces or clears items through the shared update endpoint", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ snapshot_id: `s${bodies.length}` });
    }) as unknown as typeof fetch;
    expect(
      await replacePlaylistItems(new SpotifyClient(tokens), "p", ["spotify:track:a"]),
    ).toBe("s1");
    expect(await replacePlaylistItems(new SpotifyClient(tokens), "p", [])).toBe("s2");
    expect(bodies).toEqual([{ uris: ["spotify:track:a"] }, { uris: [] }]);
  });
});
