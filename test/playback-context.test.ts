import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import {
  playbackContextDrill,
  PlaybackContextUnavailableError,
} from "../src/store/playback-context.ts";

const realFetch = globalThis.fetch;
const ID = "4uLU6hMCjMI75M1A2tKUQC";
const tokens = {
  accessToken: async () => "token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

const item = {
  id: "track",
  name: "Song",
  uri: "spotify:track:track",
  duration_ms: 1_000,
  artists: [{ id: "artist", name: "Artist", uri: `spotify:artist:${ID}` }],
  album: { id: ID, name: "Album", uri: `spotify:album:${ID}`, images: [] },
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("playbackContextDrill", () => {
  test("reuses current track metadata for album and artist contexts", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("unexpected request");
    }) as unknown as typeof fetch;
    const client = new SpotifyClient(tokens);

    await expect(
      playbackContextDrill({
        client,
        meId: "me",
        contextUri: item.album.uri,
        item,
      }),
    ).resolves.toEqual({ kind: "album", id: ID, name: "Album", uri: item.album.uri });
    await expect(
      playbackContextDrill({
        client,
        meId: "me",
        contextUri: item.artists[0]!.uri,
        item,
      }),
    ).resolves.toEqual({ kind: "artist", id: "artist", name: "Artist" });
    expect(requests).toBe(0);
  });

  test("opens only an owned playlist context", async () => {
    let ownerId = "me";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: ID,
          name: "Mix",
          uri: `spotify:playlist:${ID}`,
          owner: { id: ownerId, display_name: "Owner" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    await expect(
      playbackContextDrill({
        client: new SpotifyClient(tokens),
        meId: "me",
        contextUri: `spotify:playlist:${ID}`,
        item,
      }),
    ).resolves.toEqual({
      kind: "playlist",
      id: ID,
      name: "Mix",
      uri: `spotify:playlist:${ID}`,
    });

    ownerId = "someone-else";
    await expect(
      playbackContextDrill({
        client: new SpotifyClient(tokens),
        meId: "me",
        contextUri: `spotify:playlist:${ID}`,
        item,
      }),
    ).rejects.toThrow("Spotify only allows this app to open playlists you own");
  });

  test("explains when Spotify will not expose the context", async () => {
    await expect(
      playbackContextDrill({
        client: new SpotifyClient(tokens),
        meId: "me",
        contextUri: null,
        item,
      }),
    ).rejects.toEqual(new PlaybackContextUnavailableError());
  });

  test("forwards cancellation to context metadata requests", async () => {
    let requestSignal: AbortSignal | null = null;
    globalThis.fetch = (async (_input, init) => {
      requestSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
      });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = playbackContextDrill({
      client: new SpotifyClient(tokens),
      meId: "me",
      contextUri: `spotify:playlist:${ID}`,
      item,
      signal: controller.signal,
    });

    await Bun.sleep(0);
    controller.abort(new Error("superseded context lookup"));

    await expect(pending).rejects.toThrow("superseded context lookup");
    expect((requestSignal as AbortSignal | null) === controller.signal).toBeTrue();
  });
});
