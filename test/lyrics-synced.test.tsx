import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Lyrics } from "../src/api/lyrics.ts";
import type { Track } from "../src/api/types.ts";
import { useLyrics } from "../src/store/lyrics.ts";

/**
 * The sung position, under the test's control.
 *
 * `positionMs` extrapolates from a private anchor inside the playback store, which a test cannot
 * reach. Mocking it is what makes the following behaviour observable at all.
 */
let nowMs = 0;
mock.module("../src/store/playback.ts", () => ({ positionMs: () => nowMs }));

const { LyricsView } = await import("../src/ui/LyricsView.tsx");

const TRACK: Track = {
  id: "t1",
  name: "Long Song",
  uri: "spotify:track:t1",
  duration_ms: 300_000,
  artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
  album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
};

/** Thirty lines, one every ten seconds, each identifiable on screen. */
const SYNCED: Lyrics = {
  title: "Long Song",
  artists: "Artist",
  source: "lrclib",
  url: null,
  synced: true,
  lines: Array.from({ length: 30 }, (_, i) => ({
    text: `line ${String(i).padStart(2, "0")} words here`,
    atMs: i * 10_000,
  })),
};

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  nowMs = 0;
  useLyrics.getState().closeLyrics();
});

async function renderAt(at: number, width = 70, height = 20): Promise<string> {
  nowMs = at;
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(<LyricsView width={width} height={height} item={TRACK} />);
  // Two passes: the first lays out and the follow effect scrolls, the second draws the result.
  await Bun.sleep(30);
  await setup.renderOnce();
  await Bun.sleep(30);
  await setup.renderOnce();
  return setup.captureCharFrame();
}

function seed(over: Partial<ReturnType<typeof useLyrics.getState>> = {}) {
  useLyrics.setState({
    open: true,
    loading: false,
    error: null,
    lyrics: SYNCED,
    offset: 0,
    total: 0,
    trackKey: "t1",
    following: true,
    ...over,
  });
}

describe("following the music", () => {
  test("scrolls itself to the line being sung", async () => {
    seed();
    const screen = await renderAt(200_000);
    // Line 20 starts at 200s.
    expect(screen).toContain("line 20");
    expect(screen).not.toContain("line 00");
  });

  test("keeps the sung line off the very edge, so what is next is visible", async () => {
    seed();
    const screen = await renderAt(200_000);
    const rows = screen.split("\n");
    const at = rows.findIndex((row) => row.includes("line 20"));
    const lyricRows = rows.filter((row) => /line \d\d/.test(row)).length;
    expect(at).toBeGreaterThan(0);
    // Something after it is on screen — the point of centring rather than pinning to the bottom.
    expect(rows.slice(at + 1).some((row) => /line \d\d/.test(row))).toBe(true);
    expect(lyricRows).toBeGreaterThan(4);
  });

  test("moves on as the music does", async () => {
    seed();
    expect(await renderAt(50_000)).toContain("line 05");
    setup?.renderer.destroy();
    seed();
    expect(await renderAt(250_000)).toContain("line 25");
  });

  // Before the first stamped line there is nothing being sung, and nothing should be marked as if
  // it were.
  test("starts at the top during the intro", async () => {
    seed();
    const screen = await renderAt(0);
    expect(screen).toContain("line 00");
  });

  test("returns to the top after seeking back into the intro", async () => {
    seed({
      offset: 15,
      lyrics: {
        ...SYNCED,
        lines: SYNCED.lines.map((line) => ({ ...line, atMs: (line.atMs ?? 0) + 10_000 })),
      },
    });
    const screen = await renderAt(0);
    expect(screen).toContain("line 00");
    expect(screen).not.toContain("line 15");
  });

  test("stays where it was put once the reader takes over", async () => {
    seed({ following: false, offset: 0 });
    const screen = await renderAt(200_000);
    expect(screen).toContain("line 00");
    expect(screen).not.toContain("line 20");
  });

  test("offers the key that hands it back", async () => {
    seed({ following: false });
    expect(await renderAt(200_000)).toContain("f follow");
  });

  test("says nothing about following when the lyric has no timings", async () => {
    seed({
      lyrics: { ...SYNCED, synced: false, source: "genius", lines: SYNCED.lines.map((l) => ({ text: l.text, atMs: null })) },
      following: false,
    });
    expect(await renderAt(200_000)).not.toContain("f follow");
  });

  // Wide enough that `fitStatus` keeps the attribution; at 70 columns it is correctly dropped to
  // make room for the hints.
  test("names the source it followed", async () => {
    seed();
    expect(await renderAt(200_000, 120, 30)).toContain("lrclib.net");
  });

  test("nothing overflows while following", async () => {
    seed();
    for (const [w, h] of [
      [120, 40],
      [80, 24],
      [60, 20],
    ] as const) {
      const rows = (await renderAt(200_000, w, h)).split("\n");
      expect(rows.every((row) => row.length <= w)).toBe(true);
      setup?.renderer.destroy();
    }
  });
});

describe("the marker and the status line", () => {
  // The same marker the palette puts against its selected row.
  test("marks the sung line in the gutter", async () => {
    seed();
    const rows = (await renderAt(200_000)).split("\n");
    const marked = rows.filter((row) => row.includes("▌"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("line 20");
  });

  test("the marker moves with the music", async () => {
    seed();
    expect((await renderAt(70_000)).split("\n").find((r) => r.includes("▌"))).toContain("line 07");
  });

  /**
   * A stamped blank line is an instrumental gap. The lone marker is the whole point: the song is
   * still going and nobody is singing, which an empty screen would not convey.
   */
  test("holds the marker on an instrumental gap", async () => {
    const withGap = {
      ...SYNCED,
      lines: [
        { text: "before the gap", atMs: 0 },
        { text: "", atMs: 10_000 },
        { text: "after the gap", atMs: 20_000 },
      ],
    };
    seed({ lyrics: withGap });
    const rows = (await renderAt(12_000)).split("\n");
    const marked = rows.filter((row) => row.includes("▌"));
    expect(marked).toHaveLength(1);
    expect(marked[0]?.trim()).toBe("▌");
  });

  /**
   * The HUD that normally shows elapsed time is hidden behind this overlay, and a scroll range says
   * nothing while the view scrolls itself.
   */
  test("shows elapsed time instead of a scroll range while following", async () => {
    seed();
    const screen = await renderAt(125_000, 120, 30);
    expect(screen).toContain("2:05 / 5:00");
    expect(screen).not.toMatch(/\d+–\d+ of \d+/);
  });

  test("shows the scroll range again once the reader takes over", async () => {
    seed({ following: false, offset: 4 });
    const screen = await renderAt(125_000, 120, 30);
    expect(screen).toMatch(/\d+–\d+ of \d+/);
    expect(screen).not.toContain("2:05 / 5:00");
  });

  test("hides the scrollbar while the music drives it", async () => {
    seed();
    expect(await renderAt(200_000)).not.toContain("│");
  });

  test("brings the scrollbar back for manual scrolling", async () => {
    seed({ following: false, offset: 4 });
    expect(await renderAt(200_000)).toContain("│");
  });

  // An unsynced lyric is scrolled by hand only, so it always needs the scrollbar.
  test("always shows the scrollbar for an unsynced lyric", async () => {
    seed({
      lyrics: {
        ...SYNCED,
        synced: false,
        source: "genius",
        lines: SYNCED.lines.map((l) => ({ text: l.text, atMs: null })),
      },
    });
    expect(await renderAt(200_000)).toContain("│");
  });
});

describe("line rendering", () => {
  const LINE = "There's a million little battles that I'm never gonna win";
  const FILLED: Lyrics = {
    ...SYNCED,
    lines: [
      { text: "before", atMs: 0 },
      { text: LINE, atMs: 10_000 },
      { text: "after", atMs: 20_000 },
    ],
  };

  /**
   * A row is split across spans for the marker and the indent, and its colour is recomputed on every
   * frame. Both are places a line could come out altered, and a lyric missing characters is not a
   * lyric.
   */
  test("shows the whole line at any point in the song", async () => {
    for (const at of [10_000, 10_600, 12_500, 15_000, 19_900]) {
      seed({ lyrics: FILLED });
      const screen = await renderAt(at, 100, 24);
      expect(screen).toContain(LINE);
      setup?.renderer.destroy();
    }
  });

  test("shows the whole line while the page is still settling", async () => {
    // Inside the 150ms transition, when the colours are mid-blend.
    for (const at of [10_010, 10_070, 10_140]) {
      seed({ lyrics: FILLED });
      const screen = await renderAt(at, 100, 24);
      expect(screen).toContain(LINE);
      setup?.renderer.destroy();
    }
  });

  test("wraps and still keeps every word", async () => {
    seed({ lyrics: FILLED });
    const screen = await renderAt(15_000, 46, 24);
    expect(screen).toContain("There's a million little");
    expect(screen).toContain("win");
    setup?.renderer.destroy();
  });

  test("keeps a wrapped current line together with one marker in a short viewport", async () => {
    const lines = [
      ...Array.from({ length: 8 }, (_, i) => ({
        text: `earlier line ${i}`,
        atMs: i * 1_000,
      })),
      { text: LINE, atMs: 10_000 },
      { text: "after", atMs: 20_000 },
    ];
    seed({ lyrics: { ...SYNCED, lines } });

    const screen = await renderAt(15_000, 46, 12);
    expect(screen).toContain("There's a million little");
    expect(screen).toContain("win");
    expect(screen.split("\n").filter((row) => row.includes("▌"))).toHaveLength(1);
  });
});

describe("scrolling", () => {
  /**
   * One render per test, deliberately.
   *
   * `createRoot` is never unmounted, so a component from an earlier render stays alive and keeps
   * reacting to the shared clock. Rendering twice in one test lets the stale one write scroll
   * position into the store underneath the new one.
   */
  async function settleAt(at: number, width = 70, height = 20): Promise<string[]> {
    nowMs = at;
    setup = await createTestRenderer({ width, height });
    createRoot(setup.renderer).render(<LyricsView width={width} height={height} item={TRACK} />);
    await Bun.sleep(30);
    await setup.renderOnce();
    // Long enough for a walk of several rows at ~28ms each.
    await Bun.sleep(400);
    await setup.renderOnce();
    return setup.captureCharFrame().split("\n").flatMap((row) => row.match(/line (\d\d)/)?.[1] ?? []);
  }

  /**
   * The page holds still while the sung line crosses the middle band, so reading is not interrupted
   * every few seconds by a one-row twitch — which is the thing that could never be smoothed, since
   * one row is the smallest move a terminal has.
   */
  test("does not move while the line stays in the band", async () => {
    // Line 22 is sung, well inside the band for a page sitting at 15.
    seed({ offset: 15 });
    expect((await settleAt(220_000))[0]).toBe("15");
  });

  test("moves once the line reaches the edge of the band", async () => {
    // Line 24 has reached the bottom margin, so the page re-centres.
    seed({ offset: 15 });
    const visible = await settleAt(240_000);
    expect(visible[0]).toBe("19");
    expect(visible).toContain("24");
  });

  // A seek is not the song moving on; walking a screenful a row at a time would look broken.
  test("snaps rather than walks when the distance is more than a screen", async () => {
    seed({ offset: 0 });
    nowMs = 250_000;
    setup = await createTestRenderer({ width: 70, height: 20 });
    createRoot(setup.renderer).render(<LyricsView width={70} height={20} item={TRACK} />);
    await Bun.sleep(30);
    await setup.renderOnce();
    // No time for a walk — it has to be on screen already.
    expect(setup.captureCharFrame()).toContain("line 25");
  });

  test("arrives at the sung line after walking", async () => {
    seed({ offset: 15 });
    expect(await settleAt(300_000)).toContain("29");
  });
});
