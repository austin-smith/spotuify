import { afterEach, describe, expect, test } from "bun:test";
import packageMetadata from "../package.json";
import { fetchLrclib, parseLrc, pickRecord } from "../src/api/lrclib.ts";

const realFetch = globalThis.fetch;
const realDateNow = Date.now;
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realDateNow;
});

const TRACK = { name: "Song", artists: ["Artist"], durationMs: 200_000 };

describe("parseLrc", () => {
  const LRC = `[ar:Radiohead]
[ti:Paranoid Android]
[00:21.25]Please could you stop the noise?
[00:25.35]I'm trying to get some rest
[00:31.10]
[01:05.00]From all the unborn chicken voices`;

  test("reads every stamped line in order", () => {
    const lines = parseLrc(LRC);
    expect(lines.map((line) => line.text)).toEqual([
      "Please could you stop the noise?",
      "I'm trying to get some rest",
      "",
      "From all the unborn chicken voices",
    ]);
  });

  test("converts stamps to milliseconds", () => {
    expect(parseLrc(LRC)[0]?.atMs).toBe(21_250);
    expect(parseLrc(LRC).at(-1)?.atMs).toBe(65_000);
  });

  // "[00:12.1]" is a tenth of a second, not a millisecond — reading it raw runs the lyric 99% early.
  test("treats a short fraction as a fraction, not as milliseconds", () => {
    expect(parseLrc("[00:12.1]a")[0]?.atMs).toBe(12_100);
    expect(parseLrc("[00:12.12]a")[0]?.atMs).toBe(12_120);
    expect(parseLrc("[00:12.123]a")[0]?.atMs).toBe(12_123);
  });

  test("keeps stamped blank lines, which are the gaps", () => {
    expect(parseLrc(LRC)[2]).toEqual({ text: "", atMs: 31_100 });
  });

  test("preserves bracketed section labels and annotations", () => {
    expect(parseLrc("[00:10.00][Chorus]\n[00:12.00]I [whisper] softly")).toEqual([
      { text: "[Chorus]", atMs: 10_000 },
      { text: "I [whisper] softly", atMs: 12_000 },
    ]);
  });

  test("applies the global offset and clamps timestamps before playback", () => {
    expect(parseLrc("[offset:+500]\n[00:01.00]sooner")[0]?.atMs).toBe(500);
    expect(parseLrc("[offset:-500]\n[00:01.00]later")[0]?.atMs).toBe(1_500);
    expect(parseLrc("[offset:+1500]\n[00:01.00]start")[0]?.atMs).toBe(0);
  });

  test("skips metadata rows", () => {
    expect(parseLrc(LRC).some((line) => line.text.includes("Radiohead"))).toBe(false);
    expect(parseLrc("[length: 03:45]\n[00:01.00]word")).toHaveLength(1);
  });

  // A repeated chorus is written once with several stamps.
  test("emits a line once per timestamp", () => {
    const lines = parseLrc("[00:10.00][01:10.00]chorus");
    expect(lines).toEqual([
      { text: "chorus", atMs: 10_000 },
      { text: "chorus", atMs: 70_000 },
    ]);
  });

  test("sorts out-of-order stamps", () => {
    expect(parseLrc("[01:00.00]second\n[00:30.00]first").map((l) => l.text)).toEqual([
      "first",
      "second",
    ]);
  });

  test("has nothing to say about an empty or unstamped document", () => {
    expect(parseLrc("")).toEqual([]);
    expect(parseLrc("just some words\nand more")).toEqual([]);
  });
});


describe("pickRecord", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    trackName: "Song",
    artistName: "Artist",
    duration: 200,
    syncedLyrics: "[00:01.00]a",
    plainLyrics: "a",
    ...over,
  });

  test("prefers a synced record over a plain one", () => {
    const chosen = pickRecord(
      [record({ syncedLyrics: null }), record({ plainLyrics: null })],
      TRACK,
    );
    expect(chosen?.syncedLyrics).toBe("[00:01.00]a");
  });

  test("does not rank blank timing placeholders as synchronized lyrics", () => {
    const placeholder = record({
      syncedLyrics: "[00:01.00]",
      plainLyrics: "plain fallback",
      duration: 200,
    });
    const synchronized = record({ syncedLyrics: "[00:01.00]real words", duration: 201 });
    expect(pickRecord([placeholder, synchronized], TRACK)).toBe(synchronized);
  });

  /**
   * A live cut or a remix shares the title and the artist but not the length, and its stamps would
   * drift against the studio recording immediately. Better to fall through to Genius.
   */
  test("refuses a record whose length disagrees", () => {
    expect(pickRecord([record({ duration: 260 })], TRACK)).toBeNull();
  });

  test("takes the closest length among several", () => {
    const chosen = pickRecord(
      [record({ duration: 201, plainLyrics: "close" }), record({ duration: 200, plainLyrics: "exact" })],
      TRACK,
    );
    expect(chosen?.plainLyrics).toBe("exact");
  });

  test("ranks only duration-compatible records", () => {
    const validPlain = record({
      duration: 200,
      syncedLyrics: null,
      plainLyrics: "right recording",
    });
    const validInstrumental = record({
      duration: 200,
      instrumental: true,
      syncedLyrics: null,
      plainLyrics: null,
    });
    const wrongSynced = record({ duration: 260 });

    expect(pickRecord([wrongSynced, validPlain], TRACK)).toBe(validPlain);
    expect(pickRecord([wrongSynced, validInstrumental], TRACK)).toBe(validInstrumental);
  });

  test("accepts anything when the track's length is unknown", () => {
    expect(pickRecord([record({ duration: 999 })], { ...TRACK, durationMs: undefined })).not.toBeNull();
  });

  test("keeps an instrumental record, which is an answer in itself", () => {
    const chosen = pickRecord(
      [record({ instrumental: true, syncedLyrics: null, plainLyrics: null })],
      TRACK,
    );
    expect(chosen?.instrumental).toBe(true);
  });

  test("ignores records with no words at all", () => {
    expect(pickRecord([record({ syncedLyrics: null, plainLyrics: "  " })], TRACK)).toBeNull();
    expect(pickRecord([], TRACK)).toBeNull();
  });

  test("rejects fuzzy search results for a different title or artist", () => {
    const correct = record({ syncedLyrics: null, plainLyrics: "right" });
    const longerTitle = record({ trackName: "Song (Extended Mix)", plainLyrics: "wrong title" });
    const cover = record({ artistName: "Other Artist", plainLyrics: "wrong artist" });

    expect(pickRecord([longerTitle, cover, correct], TRACK)).toBe(correct);
    expect(pickRecord([longerTitle, cover], TRACK)).toBeNull();
  });

  test("accepts the requested artist inside collaboration credits", () => {
    const collaboration = record({ artistName: "Artist & Guest" });
    expect(pickRecord([collaboration], TRACK)).toBe(collaboration);
  });

  test("does not match only because a featured artist is shared", () => {
    const otherPrimary = record({ artistName: "Other Artist & Guest" });
    expect(
      pickRecord([otherPrimary], {
        ...TRACK,
        artists: ["Primary Artist", "Guest"],
      }),
    ).toBeNull();
  });
});

describe("fetchLrclib", () => {
  /** Serve `/get` and `/search` independently so the fallback path can be driven. */
  function serve(get: unknown | number, search: unknown | number): URL[] {
    const calls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      const entry = url.pathname.endsWith("/get") ? get : search;
      if (entry instanceof Error) throw entry;
      if (typeof entry === "number") return new Response("nope", { status: entry });
      return new Response(JSON.stringify(entry), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return calls;
  }

  test("returns synced lines from an exact match", async () => {
    serve({ trackName: "Song", artistName: "Artist", syncedLyrics: "[00:02.00]hello" }, 404);
    const result = await fetchLrclib(TRACK);
    expect(result).toMatchObject({ kind: "lyrics", synced: true });
    if (result.kind === "lyrics") {
      expect(result.lines).toEqual([{ text: "hello", atMs: 2_000 }]);
    }
  });

  /**
   * Regression: sending the album steered LRCLIB to a worse record. On "Feeling Whitney", artist and
   * track alone return a synced entry, artist+track+album returns an unsynced one, and album without
   * a duration returns a 29-second fragment of something else. The duration discriminates; the album
   * only misleads, because Spotify's edition suffixes are not LRCLIB's.
   */
  test("never sends the album", async () => {
    const calls = serve({ syncedLyrics: "[00:01.00]a" }, 404);
    await fetchLrclib({ ...TRACK, name: "Feeling Whitney" });
    expect(calls.every((url) => url.searchParams.get("album_name") === null)).toBe(true);
  });

  test("identifies the application and its canonical version", async () => {
    const seen: { userAgent: string | null } = { userAgent: null };
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.userAgent = new Headers(init?.headers).get("user-agent");
      return new Response(
        JSON.stringify({
          trackName: "Song",
          artistName: "Artist",
          syncedLyrics: "[00:01.00]words",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await fetchLrclib(TRACK);
    expect(seen.userAgent).toBe(
      `spotuify/${packageMetadata.version} (https://github.com/austin-smith/spotuify)`,
    );
  });

  /**
   * Regression: `/get` answers with one record, and for a track holding both timed and untimed
   * uploads it often returns the untimed one. Settling for it threw away timings that were a single
   * search away — which is exactly how the highlight stopped working on a real track.
   */
  test("looks past a plain exact match for a synced one", async () => {
    const calls = serve({ trackName: "Song", artistName: "Artist", plainLyrics: "no timings" }, [
      { trackName: "Song", artistName: "Artist", duration: 200, syncedLyrics: "[00:04.00]timed" },
    ]);
    const result = await fetchLrclib(TRACK);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ kind: "lyrics", synced: true });
  });

  test("keeps the plain words when nothing anywhere is timed", async () => {
    serve({ trackName: "Song", artistName: "Artist", plainLyrics: "no timings" }, []);
    const result = await fetchLrclib(TRACK);
    expect(result).toMatchObject({ kind: "lyrics", synced: false });
    if (result.kind === "lyrics") expect(result.lines[0]?.text).toBe("no timings");
  });

  test("keeps exact plain words when the optional search fails", async () => {
    const calls = serve(
      { trackName: "Song", artistName: "Artist", plainLyrics: "exact words" },
      new TypeError("search failed"),
    );
    const result = await fetchLrclib(TRACK);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ kind: "lyrics", synced: false });
    if (result.kind === "lyrics") expect(result.lines[0]?.text).toBe("exact words");
  });

  test("keeps exact words over a conflicting instrumental search record", async () => {
    serve(
      { trackName: "Song", artistName: "Artist", plainLyrics: "exact words" },
      [
        {
          trackName: "Song",
          artistName: "Artist",
          duration: 200,
          instrumental: true,
          syncedLyrics: null,
          plainLyrics: null,
        },
      ],
    );
    const result = await fetchLrclib(TRACK);
    expect(result).toMatchObject({ kind: "lyrics", synced: false });
    if (result.kind === "lyrics") expect(result.lines[0]?.text).toBe("exact words");
  });

  // An instrumental is a final answer; there is no better record to go looking for.
  test("does not search past an instrumental", async () => {
    const calls = serve(
      {
        trackName: "Song",
        artistName: "Artist",
        duration: 200,
        instrumental: true,
        syncedLyrics: null,
        plainLyrics: null,
      },
      [],
    );
    expect(await fetchLrclib(TRACK)).toEqual({ kind: "instrumental" });
    expect(calls).toHaveLength(1);
  });

  test("does not trust an exact response for a different recording", async () => {
    serve(
      {
        trackName: "Different Song",
        artistName: "Other Artist",
        duration: 200,
        instrumental: true,
        syncedLyrics: null,
        plainLyrics: null,
      },
      [{ trackName: "Song", artistName: "Artist", duration: 200, plainLyrics: "correct words" }],
    );
    const result = await fetchLrclib(TRACK);
    expect(result).toMatchObject({ kind: "lyrics", synced: false });
  });

  test("sends the duration in seconds, which is how the exact match is keyed", async () => {
    const calls = serve({ syncedLyrics: "[00:01.00]a" }, 404);
    await fetchLrclib(TRACK);
    expect(calls[0]?.searchParams.get("duration")).toBe("200");
    expect(calls[0]?.searchParams.get("artist_name")).toBe("Artist");
  });

  /**
   * Spotify and LRCLIB routinely disagree about a track's length by a second or two, which fails the
   * exact endpoint outright. The search fallback is what finds the lyric in those cases.
   */
  test("falls back to search when there is no exact match", async () => {
    const calls = serve(404, [
      { trackName: "Song", artistName: "Artist", duration: 200, syncedLyrics: "[00:03.00]found" },
    ]);
    const result = await fetchLrclib(TRACK);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ kind: "lyrics", synced: true });
  });

  test("falls back to plain lines when nothing is stamped", async () => {
    serve({ trackName: "Song", artistName: "Artist", plainLyrics: "one\ntwo" }, 404);
    const result = await fetchLrclib(TRACK);
    expect(result).toMatchObject({ kind: "lyrics", synced: false });
    if (result.kind === "lyrics") {
      expect(result.lines.map((line) => line.text)).toEqual(["one", "two"]);
    }
  });

  test("uses plain words when the synchronized payload contains only blank placeholders", async () => {
    serve(
      {
        trackName: "Song",
        artistName: "Artist",
        syncedLyrics: "[00:01.00]\n[00:05.00]   ",
        plainLyrics: "real words",
      },
      404,
    );
    const result = await fetchLrclib(TRACK);
    expect(result).toMatchObject({ kind: "lyrics", synced: false });
    if (result.kind === "lyrics") expect(result.lines[0]?.text).toBe("real words");
  });

  test("reports no lyrics for synchronized blank placeholders without plain words", async () => {
    serve(
      {
        trackName: "Song",
        artistName: "Artist",
        syncedLyrics: "[00:01.00]\n[00:05.00]   ",
      },
      404,
    );
    expect(await fetchLrclib(TRACK)).toEqual({ kind: "none" });
  });

  test("spaces consecutive requests by the provider's minimum interval", async () => {
    const calledAt: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calledAt.push(performance.now());
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/get")
        ? { trackName: "Song", artistName: "Artist", plainLyrics: "words" }
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await fetchLrclib(TRACK);
    expect(calledAt).toHaveLength(2);
    expect(calledAt[1]! - calledAt[0]!).toBeGreaterThanOrEqual(190);
  });

  // Worth distinguishing: searching Genius for an instrumental returns another song's words.
  test("reports an instrumental as such", async () => {
    serve(
      {
        trackName: "Song",
        artistName: "Artist",
        duration: 200,
        instrumental: true,
        syncedLyrics: null,
        plainLyrics: null,
      },
      404,
    );
    expect(await fetchLrclib(TRACK)).toEqual({ kind: "instrumental" });
  });

  test("reports nothing when both endpoints come up empty", async () => {
    serve(404, []);
    expect(await fetchLrclib(TRACK)).toEqual({ kind: "none" });
  });

  test("survives an outage without throwing at the caller", async () => {
    serve(500, 500);
    expect(await fetchLrclib(TRACK)).toEqual({ kind: "none" });
  });

  test("honors Retry-After without issuing more LRCLIB requests", async () => {
    let nowMs = 0;
    let limited = true;
    const calls: URL[] = [];
    Date.now = () => nowMs;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(new URL(String(input)));
      if (limited) {
        return new Response("limited", {
          status: 429,
          headers: { "retry-after": "30" },
        });
      }
      return new Response(
        JSON.stringify({
          trackName: "Song",
          artistName: "Artist",
          syncedLyrics: "[00:01.00]ready",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(fetchLrclib(TRACK)).rejects.toThrow("rate limited");
    expect(calls).toHaveLength(1);

    limited = false;
    await expect(fetchLrclib(TRACK)).rejects.toThrow("rate limited");
    expect(calls).toHaveLength(1);

    nowMs = 30_001;
    expect(await fetchLrclib(TRACK)).toMatchObject({ kind: "lyrics", synced: true });
    expect(calls).toHaveLength(2);
  });
});
