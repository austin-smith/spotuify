import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLyrics } from "../src/store/lyrics.ts";
import type { Lyrics } from "../src/api/lyrics.ts";
import type { Track } from "../src/api/types.ts";

const realFetch = globalThis.fetch;

const SYNCED: Lyrics = {
  title: "Song",
  artists: "Artist",
  source: "lrclib",
  url: null,
  synced: true,
  lines: [
    { text: "first", atMs: 1_000 },
    { text: "second", atMs: 5_000 },
  ],
};

const TRACK: Track = {
  id: "t1",
  name: "Song",
  uri: "spotify:track:t1",
  duration_ms: 200_000,
  artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
  album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
};

beforeEach(() => {
  useLyrics.setState({
    open: true,
    loading: false,
    error: null,
    lyrics: SYNCED,
    offset: 0,
    total: 40,
    trackKey: "t1",
    following: true,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  useLyrics.getState().closeLyrics();
});

describe("following", () => {
  /**
   * The rule that makes the feature usable: reading ahead has to win. Yanking the scroll back to the
   * sung line while someone is looking at the last verse is infuriating.
   */
  test("scrolling by hand takes over from the music", () => {
    useLyrics.getState().scrollBy(3, 10);
    expect(useLyrics.getState().following).toBe(false);
    expect(useLyrics.getState().offset).toBe(3);
  });

  test("f hands it back", () => {
    useLyrics.getState().scrollBy(3, 10);
    useLyrics.getState().setFollowing(true);
    expect(useLyrics.getState().following).toBe(true);
  });

  // The view scrolls itself through `scrollTo`; that must not read as the reader taking over.
  test("scrolling programmatically does not count as taking over", () => {
    useLyrics.getState().scrollTo(12);
    expect(useLyrics.getState().following).toBe(true);
    expect(useLyrics.getState().offset).toBe(12);
  });

  test("jumping to an edge takes over like any hand scroll", () => {
    useLyrics.getState().scrollToEdge("bottom", 10);
    expect(useLyrics.getState().offset).toBe(30);
    expect(useLyrics.getState().following).toBe(false);

    useLyrics.getState().setFollowing(true);
    useLyrics.getState().scrollToEdge("top", 10);
    expect(useLyrics.getState().offset).toBe(0);
    expect(useLyrics.getState().following).toBe(false);
  });

  test("the bottom of a lyric shorter than the viewport is the top", () => {
    useLyrics.setState({ total: 5 });
    useLyrics.getState().scrollToEdge("bottom", 10);
    expect(useLyrics.getState().offset).toBe(0);
  });

  test("a new track starts following again", () => {
    useLyrics.getState().scrollBy(5, 10);
    expect(useLyrics.getState().following).toBe(false);

    // No network needed: an episode resolves synchronously, and the flag is what is under test.
    useLyrics.getState().openLyrics({
      id: "e1",
      name: "Episode",
      uri: "spotify:episode:e1",
      duration_ms: 1,
      show: { id: "s", name: "Show" },
    });
    expect(useLyrics.getState().following).toBe(true);
  });

  test("reopening the same track from cache starts following again", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ trackName: "Song", artistName: "Artist", syncedLyrics: "[00:01.00]a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    useLyrics.getState().openLyrics(TRACK);
    for (let waited = 0; waited < 1_000 && useLyrics.getState().lyrics === null; waited += 10) {
      await Bun.sleep(10);
    }
    expect(useLyrics.getState().lyrics?.synced).toBe(true);

    useLyrics.getState().scrollBy(4, 10);
    expect(useLyrics.getState().following).toBe(false);

    useLyrics.getState().closeLyrics();
    useLyrics.getState().openLyrics(TRACK);
    expect(useLyrics.getState().following).toBe(true);
    expect(useLyrics.getState().offset).toBe(0);
  });
});
