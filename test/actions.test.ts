import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { Episode, Track } from "../src/api/types.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import {
  filterOwnedPlaylists,
  useActions,
  type ActionEntry,
} from "../src/store/actions.ts";

const realFetch = globalThis.fetch;
const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

const track = (id = "one"): Track => ({
  id,
  name: `Track ${id}`,
  uri: `spotify:track:${id}`,
  duration_ms: 200_000,
  artists: [{ id: "artist", name: "Artist", uri: "spotify:artist:artist" }],
  album: {
    id: "album",
    name: "Album",
    uri: "spotify:album:album",
    images: [],
  },
});

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await Bun.sleep(5);
  }
}

function select(id: ActionEntry["id"]): void {
  const index = useActions.getState().entries.findIndex((entry) => entry.id === id);
  if (index === -1) throw new Error(`missing action ${id}`);
  useActions.setState({ selected: index });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  useActions.getState().closeActions();
  useActions.getState().clearNotice();
});

describe("library actions", () => {
  test("resolves liked state lazily, writes it, then trusts the local result", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      if (path === "/me/library/contains") return json([false]);
      if (path === "/me/library" && method === "PUT") {
        return new Response(null, { status: 200, headers: { "content-length": "0" } });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const item = track();
    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(item);
    expect(useActions.getState().entries.some((entry) => entry.id === "library-loading")).toBe(
      true,
    );
    await waitFor(() => !useActions.getState().savedLoading);
    expect(
      useActions.getState().entries.find((entry) => entry.id === "library")?.label,
    ).toBe("save to liked songs");

    select("library");
    await useActions.getState().activate();
    expect(useActions.getState().open).toBe(false);
    expect(useActions.getState().notice).toEqual({
      kind: "success",
      message: "saved Track one to liked songs",
    });

    useActions.getState().openActions(item);
    expect(
      useActions.getState().entries.find((entry) => entry.id === "library")?.label,
    ).toBe("remove from liked songs");
    expect(calls.filter((call) => call.path === "/me/library/contains")).toHaveLength(1);
    expect(calls).toContainEqual({ method: "PUT", path: "/me/library" });
  });

  test("the direct action removes an already-liked item", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      const method = init?.method ?? "GET";
      methods.push(`${method} ${path}`);
      if (path === "/me/library/contains") return json([true]);
      return new Response(null, { status: 200, headers: { "content-length": "0" } });
    }) as unknown as typeof fetch;

    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    await actions.toggleSaved(track("liked"));

    expect(methods).toEqual(["GET /me/library/contains", "DELETE /me/library"]);
    expect(useActions.getState().notice?.message).toBe(
      "removed Track liked from liked songs",
    );
  });

  test("the direct toggle rechecks membership changed in another client", async () => {
    let saved = false;
    const methods: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      const method = init?.method ?? "GET";
      methods.push(`${method} ${path}`);
      if (path === "/me/library/contains") return json([saved]);
      if (path === "/me/library" && method === "PUT") saved = true;
      if (path === "/me/library" && method === "DELETE") saved = false;
      return new Response(null, { status: 200, headers: { "content-length": "0" } });
    }) as unknown as typeof fetch;

    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    const item = track("external");
    await actions.toggleSaved(item);
    expect(saved).toBe(true);

    // A different Spotify client removes the like after our first mutation.
    saved = false;
    await actions.toggleSaved(item);

    expect(saved).toBe(true);
    expect(methods).toEqual([
      "GET /me/library/contains",
      "PUT /me/library",
      "GET /me/library/contains",
      "PUT /me/library",
    ]);
  });

  test("does not issue duplicate writes while one item mutation is pending", async () => {
    let putRequests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/library/contains") return json([false]);
      if (init?.method === "PUT") {
        putRequests++;
        await gate;
      }
      return new Response(null, { status: 200, headers: { "content-length": "0" } });
    }) as unknown as typeof fetch;

    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    const item = track("pending");
    const first = actions.toggleSaved(item);
    const second = actions.toggleSaved(item);
    await waitFor(() => putRequests === 1);
    release?.();
    await Promise.all([first, second]);

    expect(putRequests).toBe(1);
  });

  test("keeps a failed membership check explicit and retryable", async () => {
    let failing = true;
    globalThis.fetch = (async () =>
      failing ? new Response("nope", { status: 500 }) : json([false])) as unknown as typeof fetch;

    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(track());
    await waitFor(() => !useActions.getState().savedLoading);

    expect(useActions.getState().error).toBe("nope");
    expect(useActions.getState().error).not.toContain("/me/library");
    expect(useActions.getState().entries.some((entry) => entry.id === "library-retry")).toBe(
      true,
    );

    failing = false;
    select("library-retry");
    await useActions.getState().activate();
    await waitFor(
      () => useActions.getState().entries.some((entry) => entry.id === "library"),
    );
    expect(useActions.getState().error).toBeNull();
  });

  test("ignores a membership response from a previous account configuration", async () => {
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let request = 0;
    globalThis.fetch = (async () => {
      request++;
      if (request === 1) {
        await oldGate;
        return json([true]);
      }
      return json([false]);
    }) as unknown as typeof fetch;

    const item = track();
    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "old");
    actions.openActions(item);
    await Bun.sleep(5);

    actions.configure(new SpotifyClient(tokens), "new");
    actions.openActions(item);
    releaseOld?.();
    await waitFor(() => !useActions.getState().savedLoading);

    expect(
      useActions.getState().entries.find((entry) => entry.id === "library")?.label,
    ).toBe("save to liked songs");
  });

  test("reports unsupported local files instead of silently ignoring the direct action", async () => {
    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    await actions.toggleSaved({
      ...track("local"),
      uri: "spotify:local:Artist:Album:Track:100",
      is_local: true,
    });
    expect(useActions.getState().notice).toEqual({
      kind: "error",
      message: "this item cannot be saved to liked songs",
    });
  });
});

describe("add to playlist", () => {
  test("offers only owned playlists and appends without a duplicate preflight", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      const method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      if (path === "/me/library/contains") return json([false]);
      if (path === "/me/playlists") {
        return json({
          items: [
            {
              id: "mine",
              name: "Road Trip",
              uri: "spotify:playlist:mine",
              owner: { id: "me", display_name: "Me" },
            },
            {
              id: "followed",
              name: "Someone Else",
              uri: "spotify:playlist:followed",
              owner: { id: "other", display_name: "Other" },
            },
          ],
          next: null,
        });
      }
      if (path === "/playlists/mine/items" && method === "POST") {
        return json({ snapshot_id: "snapshot" }, 201);
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const item = track();
    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(item);
    select("add-to-playlist");
    await actions.activate();

    expect(useActions.getState()).toMatchObject({
      mode: "playlists",
      playlistsLoading: false,
      playlistSelected: 0,
    });
    expect(useActions.getState().playlists.map((playlist) => playlist.id)).toEqual(["mine"]);

    await useActions.getState().activate();
    expect(useActions.getState().open).toBe(false);
    expect(useActions.getState().notice?.message).toBe("added Track one to Road Trip");
    expect(calls).toContainEqual({
      method: "POST",
      path: "/playlists/mine/items",
      body: { uris: ["spotify:track:one"] },
    });
    expect(
      calls.some(
        (call) => call.method === "GET" && call.path === "/playlists/mine/items",
      ),
    ).toBe(false);
  });

  test("keeps a picker failure when the earlier membership request finishes", async () => {
    let releaseMembership: (() => void) | undefined;
    const membershipGate = new Promise<void>((resolve) => {
      releaseMembership = resolve;
    });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/library/contains") {
        await membershipGate;
        return json([false]);
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(track("late-membership"));
    useActions.setState({
      mode: "playlists",
      error: "catalog unavailable",
    });
    expect(useActions.getState()).toMatchObject({
      mode: "playlists",
      error: "catalog unavailable",
    });

    releaseMembership?.();
    await waitFor(() => !useActions.getState().savedLoading);
    expect(useActions.getState()).toMatchObject({
      mode: "playlists",
      error: "catalog unavailable",
    });
  });

  test("filters destinations locally and case-insensitively", () => {
    const playlists = [
      {
        id: "one",
        name: "Road Trip",
        uri: "spotify:playlist:one",
        ownerId: "me",
        ownerName: "Me",
        mine: true,
      },
      {
        id: "two",
        name: "Night Drive",
        uri: "spotify:playlist:two",
        ownerId: "me",
        ownerName: "Me",
        mine: true,
      },
      {
        id: "other",
        name: "Road Trip Shared",
        uri: "spotify:playlist:other",
        ownerId: "other",
        ownerName: "Other",
        mine: false,
      },
    ];

    expect(filterOwnedPlaylists(playlists, "ROAD").map((playlist) => playlist.id)).toEqual([
      "one",
    ]);
  });

  test("offers the picker for Spotify episodes", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/library/contains") return json([false]);
      return json({ items: [], next: null });
    }) as unknown as typeof fetch;
    const episode: Episode = {
      id: "episode",
      name: "Episode",
      uri: "spotify:episode:episode",
      duration_ms: 100_000,
      show: { id: "show", name: "Show" },
    };

    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(episode);

    expect(
      useActions.getState().entries.some((entry) => entry.id === "add-to-playlist"),
    ).toBe(true);
    await waitFor(() => !useActions.getState().savedLoading);
    expect(
      useActions.getState().entries.find((entry) => entry.id === "library")?.label,
    ).toBe("save to your episodes");
    select("library");
    await useActions.getState().activate();
    expect(useActions.getState().notice?.message).toBe("saved Episode to your episodes");
  });

  test("locks the workflow while a playlist write is in flight", async () => {
    let posts = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/library/contains") return json([false]);
      if (path === "/me/playlists") {
        return json({
          items: [
            {
              id: "mine",
              name: "Mine",
              uri: "spotify:playlist:mine",
              owner: { id: "me", display_name: "Me" },
            },
          ],
          next: null,
        });
      }
      if (path === "/playlists/mine/items" && init?.method === "POST") {
        posts++;
        await gate;
        return json({ snapshot_id: "snapshot" }, 201);
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const item = track("locked");
    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(item);
    select("add-to-playlist");
    await actions.activate();
    const write = useActions.getState().activate();
    await waitFor(() => posts === 1);

    useActions.getState().back();
    useActions.getState().closeActions();
    useActions.getState().setPlaylistQuery("changed");
    const duplicate = useActions.getState().activate();
    expect(useActions.getState()).toMatchObject({
      open: true,
      mode: "playlists",
      busy: true,
      target: item,
      playlistQuery: "",
    });
    expect(posts).toBe(1);

    release?.();
    await Promise.all([write, duplicate]);
    expect(posts).toBe(1);
    expect(useActions.getState().open).toBe(false);
  });

  test("escape from the picker returns to the action list without losing its target", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      if (path === "/me/library/contains") return json([false]);
      return json({ items: [], next: null });
    }) as unknown as typeof fetch;

    const item = track();
    const actions = useActions.getState();
    actions.configure(new SpotifyClient(tokens), "me");
    actions.openActions(item, "palette");
    select("add-to-playlist");
    await actions.activate();
    useActions.getState().back();

    expect(useActions.getState()).toMatchObject({
      open: true,
      mode: "actions",
      target: item,
      origin: "palette",
    });
  });
});

describe("action list movement", () => {
  const drillEntry = (id: string): ActionEntry => ({
    id,
    kind: "drill",
    label: id,
    detail: "",
    disabled: false,
    drill: { kind: "artist", id, name: id },
  });

  const loadingEntry: ActionEntry = {
    id: "library-loading",
    kind: "library-loading",
    label: "…",
    detail: "",
    disabled: true,
  };

  function withEntries(entries: ActionEntry[], selected: number): void {
    useActions.setState({ open: true, mode: "actions", entries, selected });
  }

  // The wheel reports multi-row deltas; sign-only movement lagged behind the other lists.
  test("moves by the full delta, not its sign", () => {
    withEntries(["a", "b", "c", "d", "e"].map(drillEntry), 0);
    useActions.getState().move(3);
    expect(useActions.getState().selected).toBe(3);
    useActions.getState().move(-2);
    expect(useActions.getState().selected).toBe(1);
  });

  test("disabled entries are skipped, not counted", () => {
    withEntries([drillEntry("a"), loadingEntry, drillEntry("b"), drillEntry("c")], 0);
    useActions.getState().move(2);
    expect(useActions.getState().selected).toBe(3);
  });

  test("stops at the ends without wrapping", () => {
    withEntries(["a", "b", "c"].map(drillEntry), 1);
    useActions.getState().move(10);
    expect(useActions.getState().selected).toBe(2);
    useActions.getState().move(-10);
    expect(useActions.getState().selected).toBe(0);
  });
});
