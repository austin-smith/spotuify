import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { useLibraryBrowser } from "../src/store/library-browser.ts";

const realFetch = globalThis.fetch;
const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

const playlist = (id: string, owner = "me") => ({
  id,
  name: `Playlist ${id}`,
  uri: `spotify:playlist:${id}`,
  owner: { id: owner, display_name: owner === "me" ? "Austin" : "Someone Else" },
});

const album = (id: string) => ({
  id,
  name: `Album ${id}`,
  uri: `spotify:album:${id}`,
  images: [],
  release_date: "2020-01-01",
  total_tracks: 10,
});

const artist = (id: string) => ({
  id,
  name: `Artist ${id}`,
  uri: `spotify:artist:${id}`,
});

const track = (id: string) => ({
  id,
  name: `Track ${id}`,
  uri: `spotify:track:${id}`,
  duration_ms: 200_000,
  type: "track",
  artists: [artist("performer")],
  album: album("parent"),
});

function rateLimited(retryAfter: string): Response {
  return new Response(
    JSON.stringify({ error: { status: 429, message: "Too many requests" } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": retryAfter,
      },
    },
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for library state");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  useLibraryBrowser.getState().closeLibrary();
});

describe("library browser", () => {
  test("shows the complete playlist catalog instead of a home-screen slice", async () => {
    const playlists = Array.from({ length: 23 }, (_, index) => playlist(String(index)));
    globalThis.fetch = (async () => Response.json({ items: playlists, next: null })) as unknown as typeof fetch;

    useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().loaded());

    expect(useLibraryBrowser.getState().rows()).toHaveLength(23);
    expect(useLibraryBrowser.getState().total()).toBe(23);
    expect(useLibraryBrowser.getState().rows().at(-1)).toMatchObject({
      kind: "result",
      label: "Playlist 22",
    });
  });

  test("loads sections on demand and retains each section's local filter", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      calls.push(path);
      if (path === "/me/playlists") {
        return Response.json({ items: [playlist("one")], next: null });
      }
      if (path === "/me/albums") {
        return Response.json({ items: [{ album: album("violet") }, { album: album("boxer") }], next: null });
      }
      if (path === "/me/following") {
        return Response.json({ artists: { items: [artist("national")], cursors: { after: null } } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const library = useLibraryBrowser.getState();
    library.configure(new SpotifyClient(tokens), "US", "me");
    library.openLibrary();
    await waitFor(() => useLibraryBrowser.getState().loaded());
    expect(calls).toEqual(["/me/playlists"]);

    useLibraryBrowser.getState().setSection("albums");
    await waitFor(() => useLibraryBrowser.getState().loaded());
    useLibraryBrowser.getState().setQuery("violet");
    expect(useLibraryBrowser.getState().rows().map((row) => row.kind === "result" ? row.label : "")).toEqual([
      "Album violet",
    ]);

    useLibraryBrowser.getState().setSection("artists");
    await waitFor(() => useLibraryBrowser.getState().loaded());
    expect(useLibraryBrowser.getState().current()?.label).toBe("Artist national");

    useLibraryBrowser.getState().setSection("albums");
    expect(useLibraryBrowser.getState().text()).toBe("violet");
    expect(calls).toEqual(["/me/playlists", "/me/albums", "/me/following"]);
  });

  test("drills into an owned playlist and returns to the same library row", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/playlists") {
        return Response.json({ items: [playlist("one"), playlist("two")], next: null });
      }
      if (path === "/playlists/one/items") {
        return Response.json({ items: [{ item: track("inside") }], next: null });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().loaded());
    const target = useLibraryBrowser.getState().current()?.drill;
    expect(target).toMatchObject({ kind: "playlist", id: "one" });
    if (target === undefined) throw new Error("expected owned playlist to expose a drill target");

    useLibraryBrowser.getState().drillInto(target);
    await waitFor(() => useLibraryBrowser.getState().loaded());
    expect(useLibraryBrowser.getState().depth()).toBe(2);
    expect(useLibraryBrowser.getState().current()?.label).toBe("Track inside");

    expect(useLibraryBrowser.getState().back()).toBeTrue();
    expect(useLibraryBrowser.getState().depth()).toBe(1);
    expect(useLibraryBrowser.getState().current()?.label).toBe("Playlist one");
  });

  test("keeps a followed playlist playable without offering an inaccessible drill", async () => {
    globalThis.fetch = (async () =>
      Response.json({ items: [playlist("followed", "other")], next: null })) as unknown as typeof fetch;

    useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().loaded());

    const current = useLibraryBrowser.getState().current();
    expect(current).toMatchObject({
      detail: "Someone Else",
      play: { contextUri: "spotify:playlist:followed" },
    });
    expect(current?.drill).toBeUndefined();
  });

  test("retries a failed section explicitly", async () => {
    let albumRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/playlists") return Response.json({ items: [], next: null });
      if (path === "/me/albums") {
        albumRequests++;
        return albumRequests === 1
          ? new Response("failed", { status: 500 })
          : Response.json({ items: [{ album: album("recovered") }], next: null });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().loaded());
    useLibraryBrowser.getState().setSection("albums");
    await waitFor(() => useLibraryBrowser.getState().error() !== null);

    useLibraryBrowser.getState().retry();
    await waitFor(() => useLibraryBrowser.getState().loaded());
    expect(useLibraryBrowser.getState().current()?.label).toBe("Album recovered");
    expect(albumRequests).toBe(2);
  });

  test("uses the retried root request to probe an indefinite cooldown", async () => {
    let requests = 0;
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests++;
      const url = new URL(String(input));
      paths.push(url.pathname.replace("/v1", ""));
      return requests === 1
        ? rateLimited("not-a-time")
        : Response.json({ items: [playlist("recovered")], next: null });
    }) as unknown as typeof fetch;

    useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().error() !== null);

    useLibraryBrowser.getState().retry();
    await waitFor(() => useLibraryBrowser.getState().loaded());

    expect(useLibraryBrowser.getState().current()?.label).toBe("Playlist recovered");
    expect(paths).toEqual(["/me/playlists", "/me/playlists"]);
    expect(requests).toBe(2);
  });

  test("uses the retried drill request to probe an indefinite cooldown", async () => {
    let itemRequests = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/playlists") {
        return Response.json({ items: [playlist("one")], next: null });
      }
      if (path === "/playlists/one/items") {
        itemRequests++;
        return itemRequests === 1
          ? rateLimited("not-a-time")
          : Response.json({ items: [{ item: track("recovered") }], next: null });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().loaded());
    const target = useLibraryBrowser.getState().current()?.drill;
    if (target === undefined) throw new Error("expected owned playlist to expose a drill target");

    useLibraryBrowser.getState().drillInto(target);
    await waitFor(() => useLibraryBrowser.getState().error() !== null);
    useLibraryBrowser.getState().retry();
    await waitFor(() => useLibraryBrowser.getState().loaded());

    expect(useLibraryBrowser.getState().current()?.label).toBe("Track recovered");
    expect(itemRequests).toBe(2);
  });

  test("never lets a manual retry bypass a finite cooldown", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return rateLimited("60");
    }) as unknown as typeof fetch;

    const spotify = new SpotifyClient(tokens, { now: () => 10_000 });
    useLibraryBrowser.getState().configure(spotify, "US", "me");
    useLibraryBrowser.getState().openLibrary();
    await waitFor(() => useLibraryBrowser.getState().error() !== null);

    useLibraryBrowser.getState().retry();
    await waitFor(
      () => !useLibraryBrowser.getState().loading() && useLibraryBrowser.getState().error() !== null,
    );

    expect(requests).toBe(1);
    expect(spotify.getCooldown()?.retryAt).toBe(70_000);
  });
});
