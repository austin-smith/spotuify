import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { usePlaylistCatalog } from "../src/store/playlists.ts";

const realFetch = globalThis.fetch;
const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function response(id: string, owner = "me") {
  return {
    items: [
      {
        id,
        name: id,
        uri: `spotify:playlist:${id}`,
        owner: { id: owner, display_name: owner },
      },
    ],
    next: null,
  };
}

describe("shared playlist catalog", () => {
  test("pages the account once and reuses the completed result", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json(response("one"));
    }) as unknown as typeof fetch;

    const catalog = usePlaylistCatalog.getState();
    catalog.configure(new SpotifyClient(tokens), "me");
    const first = await catalog.load({ priority: "background" });
    const second = await catalog.load({ priority: "foreground" });

    expect(first.map((playlist) => playlist.id)).toEqual(["one"]);
    expect(second).toBe(first);
    expect(requests).toBe(1);
  });

  test("coalesces simultaneous consumers before pagination starts", async () => {
    let requests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      requests++;
      await gate;
      return Response.json(response("shared"));
    }) as unknown as typeof fetch;

    const catalog = usePlaylistCatalog.getState();
    catalog.configure(new SpotifyClient(tokens), "me");
    const first = catalog.load();
    const second = catalog.load({ priority: "foreground" });
    release?.();

    expect(await first).toEqual(await second);
    expect(requests).toBe(1);
  });

  test("can refresh a completed account snapshot for the destination picker", async () => {
    let request = 0;
    globalThis.fetch = (async () => {
      request++;
      return Response.json({
        items: [
          {
            id: `playlist-${request}`,
            name: `Playlist ${request}`,
            uri: `spotify:playlist:${request}`,
            owner: { id: "me", display_name: "Me" },
          },
        ],
        next: null,
      });
    }) as unknown as typeof fetch;

    const catalog = usePlaylistCatalog.getState();
    catalog.configure(new SpotifyClient(tokens), "me");
    expect(
      (await catalog.load({ priority: "background" })).map((playlist) => playlist.id),
    ).toEqual(["playlist-1"]);
    expect(
      (await catalog.load({ priority: "foreground", force: true })).map(
        (playlist) => playlist.id,
      ),
    ).toEqual(["playlist-2"]);
    expect(request).toBe(2);
  });

  test("clears account-scoped metadata when reconfigured", async () => {
    let id = "old";
    globalThis.fetch = (async () => Response.json(response(id))) as unknown as typeof fetch;

    const catalog = usePlaylistCatalog.getState();
    catalog.configure(new SpotifyClient(tokens), "old-account");
    await catalog.load();
    expect(usePlaylistCatalog.getState().playlists[0]?.id).toBe("old");

    id = "new";
    catalog.configure(new SpotifyClient(tokens), "new-account");
    expect(usePlaylistCatalog.getState()).toMatchObject({
      playlists: [],
      loaded: false,
      loading: false,
      error: null,
    });
    await catalog.load();
    expect(usePlaylistCatalog.getState().playlists[0]?.id).toBe("new");
  });
});
