import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { EMPTY_RESULTS, type SearchResults } from "../src/api/search.ts";
import { firstSelectable, toAlbumRows, toHomeRows, toRows } from "../src/store/rows.ts";
import { useSearch } from "../src/store/search.ts";
import { Palette } from "../src/ui/Palette.tsx";

const RESULTS: SearchResults = {
  tracks: [
    {
      id: "1",
      name: "Miss You - Bonus Track",
      uri: "spotify:track:1",
      duration_ms: 206_000,
      artists: [
        { id: "a1", name: "Oliver Tree", uri: "spotify:artist:a1" },
        { id: "a2", name: "Robin Schulz", uri: "spotify:artist:a2" },
      ],
      album: { id: "al", name: "Alone In A Crowd", uri: "spotify:album:al", images: [] },
    },
    {
      id: "2",
      name: "Life Goes On",
      uri: "spotify:track:2",
      duration_ms: 161_000,
      artists: [{ id: "a1", name: "Oliver Tree", uri: "spotify:artist:a1" }],
      album: { id: "al2", name: "Ugly is Beautiful", uri: "spotify:album:al2", images: [] },
    },
  ],
  artists: [{ id: "a1", name: "Oliver Tree", uri: "spotify:artist:a1" }],
  albums: [
    {
      id: "al2",
      name: "Ugly is Beautiful",
      uri: "spotify:album:al2",
      images: [],
      release_date: "2020-07-17",
      total_tracks: 14,
    },
  ],
  playlists: [
    {
      id: "p1",
      name: "This Is Oliver Tree",
      uri: "spotify:playlist:p1",
      owner: { display_name: "Spotify" },
      tracks: { total: 50 },
    },
  ],
};

/** Seed a single root frame directly; the debounce and network path are covered elsewhere. */
function seedFrames(
  query: string,
  rows: ReturnType<typeof toRows>,
  extra: { loading?: boolean; showingHome?: boolean; title?: string; depth?: number } = {},
) {
  const frame = {
    rows,
    selected: firstSelectable(rows),
    loading: extra.loading ?? false,
    filter: "",
    ...(extra.title !== undefined ? { title: extra.title } : {}),
  };
  useSearch.setState({
    open: true,
    query,
    frames: extra.depth === 2 ? [{ rows: [], selected: -1, loading: false, filter: "" }, frame] : [frame],
    error: null,
    showingHome: extra.showingHome ?? false,
  });
}

function seed(query: string, results: SearchResults, loading = false) {
  seedFrames(query, toRows(results), { loading });
}

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  useSearch.setState({
    open: false,
    query: "",
    frames: [{ rows: [], selected: -1, loading: false, filter: "" }],
    error: null,
    showingHome: true,
  });
});

async function render(width: number, height: number): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(<Palette width={width} height={height} />);
  // The React reconciler commits asynchronously; without this the frame is blank.
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [120, 40],
  [100, 32],
  [80, 24],
  [60, 20],
];

describe("palette", () => {
  test.each(SIZES)("nothing overflows at %ix%i", async (w, h) => {
    seed("oliver tree", RESULTS);
    const lines = await render(w, h);
    for (const line of lines.slice(0, h)) expect(line.length).toBeLessThanOrEqual(w);
  });

  test.each(SIZES)("query and prompt are visible at %ix%i", async (w, h) => {
    seed("oliver tree", RESULTS);
    const screen = (await render(w, h)).join("\n");
    expect(screen).toContain("oliver tree");
    expect(screen).toContain("›");
  });

  test("groups results under headers", async () => {
    seed("oliver tree", RESULTS);
    const screen = (await render(100, 32)).join("\n");
    for (const header of ["TRACKS", "ARTISTS", "ALBUMS", "PLAYLISTS"]) {
      expect(screen).toContain(header);
    }
  });

  test("shows track durations and album metadata", async () => {
    seed("oliver tree", RESULTS);
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("3:26");
    expect(screen).toContain("2020 · 14 tracks");
    // Playlists show only their owner: Spotify returns no track count for them, from search or
    // from /me/playlists.
    expect(screen).toContain("Spotify");
  });

  test("marks the selected row", async () => {
    seed("oliver tree", RESULTS);
    const lines = await render(100, 32);
    const marked = lines.filter((l) => l.includes("▌"));
    // Exactly one row carries the selection marker.
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Miss You");
  });

  test("prompts before anything is typed and nothing is loaded", async () => {
    seedFrames("", [], { showingHome: true });
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("type to search");
  });

  test("labels the pre-typing view as your library", async () => {
    seedFrames("", toHomeRows({ recent: [RESULTS.tracks[0]!], top: [], playlists: [] }), { showingHome: true });
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("RECENTLY PLAYED");
    expect(screen).toContain("your library");
  });

  test("reports an empty result set", async () => {
    seed("zzzzzz", EMPTY_RESULTS);
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("no results");
  });

  test("shows a searching state", async () => {
    seed("oli", EMPTY_RESULTS, true);
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("searching");
  });

  test("surfaces an error over the status line", async () => {
    seed("oliver", EMPTY_RESULTS);
    useSearch.setState({ error: "Spotify API 429 on /search: slow down" });
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("429");
  });

  test("always shows the key hints", async () => {
    seed("oliver tree", RESULTS);
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("esc close");
    expect(screen).toContain("open");
  });

  test("a drilled frame shows a breadcrumb and back hint", async () => {
    seedFrames("", toAlbumRows({ name: "Boxer", uri: "spotify:album:b" }, [
      { id: "1", name: "Fake Empire", uri: "spotify:track:1", duration_ms: 205_040, track_number: 1, artists: [{ id: "a", name: "The National", uri: "u" }] },
      { id: "2", name: "Mistaken for Strangers", uri: "spotify:track:2", duration_ms: 210_960, track_number: 2, artists: [{ id: "a", name: "The National", uri: "u" }] },
    ]), { title: "Boxer", depth: 2 });

    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("Boxer");
    expect(screen).toContain("Fake Empire");
    expect(screen).toContain("esc back");
    expect(screen).toContain("type to filter");
  });

  test("layout at 100x32", async () => {
    seed("oliver tree", RESULTS);
    expect((await render(100, 32)).join("\n")).toMatchSnapshot();
  });

  test("layout at 60x20", async () => {
    seed("oliver tree", RESULTS);
    expect((await render(60, 20)).join("\n")).toMatchSnapshot();
  });
});
