import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { Lyrics } from "../src/api/lyrics.ts";
import type { Track } from "../src/api/types.ts";
import { useLyrics } from "../src/store/lyrics.ts";
import { LyricsView } from "../src/ui/LyricsView.tsx";

const TRACK: Track = {
  id: "1",
  name: "Paranoid Android",
  uri: "spotify:track:1",
  duration_ms: 386_000,
  artists: [{ id: "a1", name: "Radiohead", uri: "spotify:artist:a1" }],
  album: { id: "al", name: "OK Computer", uri: "spotify:album:al", images: [] },
};

const LYRICS: Lyrics = {
  title: "Paranoid Android",
  artists: "Radiohead",
  url: "https://genius.com/Radiohead-paranoid-android-lyrics",
  lines: [
    "[Verse 1]",
    "Please could you stop the noise? I'm trying to get some rest",
    "From all the unborn chicken voices in my head",
    "",
    "[Refrain]",
    "What's that? (I may be paranoid but not an android)",
    "What's that? (I may be paranoid but not an android)",
    "",
    "[Verse 2]",
    "When I am king you will be first against the wall",
    "With your opinion, which is of no consequence at all",
  ],
};

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  useLyrics.setState({
    open: false,
    loading: false,
    error: null,
    lyrics: null,
    offset: 0,
    total: 0,
    trackKey: null,
  });
});

async function render(width: number, height: number): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(<LyricsView width={width} height={height} item={TRACK} />);
  // The React reconciler commits asynchronously; without this the frame is blank.
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

function seed(state: Partial<ReturnType<typeof useLyrics.getState>>) {
  useLyrics.setState({ open: true, loading: false, error: null, offset: 0, ...state });
}

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [120, 40],
  [100, 32],
  [80, 24],
  [60, 20],
];

describe("lyrics overlay", () => {
  test.each(SIZES)("nothing overflows at %ix%i", async (w, h) => {
    seed({ lyrics: LYRICS });
    const screen = await render(w, h);
    expect(screen.every((line) => line.length <= w)).toBe(true);
    // `captureCharFrame` ends with a trailing newline, hence the empty last element.
    expect(screen.filter((line) => line.length > 0).length).toBeLessThanOrEqual(h);
  });

  test("shows the track, the words and where they came from", async () => {
    seed({ lyrics: LYRICS });
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("PARANOID ANDROID");
    expect(screen).toContain("[Verse 1]");
    expect(screen).toContain("Please could you stop the noise?");
    expect(screen).toContain("genius.com");
  });

  test("says what it is doing while it looks", async () => {
    seed({ loading: true, lyrics: null });
    expect((await render(100, 32)).join("\n")).toContain("searching genius");
  });

  // The failure the user will actually hit: Genius has no page for the track.
  test("shows a failure in place of the words, with a way to retry", async () => {
    seed({ lyrics: null, error: "no lyrics found for this track" });
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("no lyrics found for this track");
    expect(screen).toContain("r retry");
  });

  test("scrolls to the offset rather than always starting at the top", async () => {
    seed({ lyrics: LYRICS, offset: 8 });
    const screen = (await render(60, 20)).join("\n");
    expect(screen).toContain("When I am king");
    expect(screen).not.toContain("Please could you stop");
  });

  // A lyric taller than the overlay is the normal case, so the indicator has to appear.
  test("shows a scroll indicator only when there is more than fits", async () => {
    seed({ lyrics: LYRICS });
    expect((await render(60, 12)).join("\n")).toContain("│");
    setup?.renderer.destroy();

    seed({ lyrics: { ...LYRICS, lines: ["[Verse 1]", "One line"] } });
    expect((await render(100, 32)).join("\n")).not.toContain("│");
  });

  test("wraps rather than clipping a line too long for the width", async () => {
    seed({ lyrics: LYRICS });
    const screen = (await render(60, 20)).join("\n");
    // Both halves of the wrapped line have to survive; truncating would drop the tail.
    expect(screen).toContain("Please could you stop the noise?");
    expect(screen).toContain("some rest");
  });

  test("renders the words at 100x32", async () => {
    seed({ lyrics: LYRICS });
    expect((await render(100, 32)).join("\n")).toMatchSnapshot();
  });

  test("renders the words at 60x20", async () => {
    seed({ lyrics: LYRICS });
    expect((await render(60, 20)).join("\n")).toMatchSnapshot();
  });
});
