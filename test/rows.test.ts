import { describe, expect, test } from "bun:test";
import type { SearchResults } from "../src/api/search.ts";
import { EMPTY_RESULTS } from "../src/api/search.ts";
import { firstSelectable, moveSelection, toRows, windowStart, type Row } from "../src/store/rows.ts";

const track = (name: string, ms = 200_000) => ({
  id: name,
  name,
  uri: `spotify:track:${name}`,
  duration_ms: ms,
  artists: [{ id: "a", name: "Oliver Tree", uri: "spotify:artist:a" }],
  album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
});

const results = (over: Partial<SearchResults> = {}): SearchResults => ({
  ...EMPTY_RESULTS,
  ...over,
});

describe("toRows", () => {
  test("omits groups with no results", () => {
    const rows = toRows(results({ tracks: [track("One")] }));
    expect(rows.map((r) => r.kind)).toEqual(["header", "result"]);
    expect(rows.filter((r) => r.kind === "header")).toHaveLength(1);
  });

  test("returns nothing for empty results", () => {
    expect(toRows(EMPTY_RESULTS)).toEqual([]);
  });

  test("orders groups tracks, artists, albums, playlists", () => {
    const rows = toRows(
      results({
        tracks: [track("T")],
        artists: [{ id: "a", name: "A", uri: "spotify:artist:a" }],
        albums: [{ id: "b", name: "B", uri: "spotify:album:b", images: [] }],
        playlists: [{ id: "c", name: "C", uri: "spotify:playlist:c" }],
      }),
    );
    const headers = rows.filter((r): r is Extract<Row, { kind: "header" }> => r.kind === "header");
    expect(headers.map((h) => h.label)).toEqual(["TRACKS", "ARTISTS", "ALBUMS", "PLAYLISTS"]);
  });

  test("tracks play by uri, everything else by context", () => {
    const rows = toRows(
      results({
        tracks: [track("T")],
        albums: [{ id: "b", name: "B", uri: "spotify:album:b", images: [] }],
      }),
    );
    const [, trackRow, , albumRow] = rows;
    expect(trackRow?.kind === "result" && trackRow.play).toEqual({ uris: ["spotify:track:T"] });
    expect(albumRow?.kind === "result" && albumRow.play).toEqual({
      contextUri: "spotify:album:b",
    });
  });

  test("shows track duration as the trailing column", () => {
    const rows = toRows(results({ tracks: [track("T", 206_000)] }));
    expect(rows[1]?.kind === "result" && rows[1].trailing).toBe("3:26");
  });

  test("tolerates albums and playlists missing optional metadata", () => {
    const rows = toRows(
      results({
        albums: [{ id: "b", name: "B", uri: "spotify:album:b", images: [] }],
        playlists: [{ id: "c", name: "C", uri: "spotify:playlist:c" }],
      }),
    );
    for (const row of rows) {
      if (row.kind === "result") expect(typeof row.detail).toBe("string");
    }
  });

  test("builds album detail from year and track count", () => {
    const rows = toRows(
      results({
        albums: [
          {
            id: "b",
            name: "B",
            uri: "spotify:album:b",
            images: [],
            release_date: "2020-07-17",
            total_tracks: 14,
          },
        ],
      }),
    );
    expect(rows[1]?.kind === "result" && rows[1].detail).toBe("2020 · 14 tracks");
  });
});

describe("moveSelection", () => {
  const rows = toRows(
    results({
      tracks: [track("T1"), track("T2")],
      artists: [{ id: "a", name: "A1", uri: "spotify:artist:a" }],
    }),
  );
  // rows: header, T1, T2, header, A1  ->  selectable indices 1, 2, 4

  test("skips headers moving down", () => {
    expect(moveSelection(rows, 2, 1)).toBe(4);
  });

  test("skips headers moving up", () => {
    expect(moveSelection(rows, 4, -1)).toBe(2);
  });

  // Wrapping from the end back to the start makes a long list feel like it lost your place.
  test("stops at the ends instead of wrapping", () => {
    expect(moveSelection(rows, 4, 1)).toBe(4);
    expect(moveSelection(rows, 1, -1)).toBe(1);
  });

  test("honours multi-step deltas", () => {
    expect(moveSelection(rows, 1, 2)).toBe(4);
    expect(moveSelection(rows, 4, -2)).toBe(1);
  });

  test("clamps an over-long delta to the last selectable row", () => {
    expect(moveSelection(rows, 1, 99)).toBe(4);
    expect(moveSelection(rows, 4, -99)).toBe(1);
  });

  test("recovers when the current index is not selectable", () => {
    expect(moveSelection(rows, 0, 1)).toBe(1);
    expect(moveSelection(rows, 3, 1)).toBe(4);
  });

  test("returns -1 when nothing is selectable", () => {
    expect(moveSelection([], 0, 1)).toBe(-1);
    expect(moveSelection([{ kind: "header", label: "X" }], 0, 1)).toBe(-1);
  });
});

describe("firstSelectable", () => {
  test("finds the first result row", () => {
    expect(firstSelectable(toRows(results({ tracks: [track("T")] })))).toBe(1);
  });

  test("is -1 with no results", () => {
    expect(firstSelectable([])).toBe(-1);
    expect(firstSelectable([{ kind: "header", label: "X" }])).toBe(-1);
  });
});

describe("windowStart", () => {
  const many: Row[] = Array.from({ length: 30 }, (_, i) => ({
    kind: "result",
    label: `r${i}`,
    detail: "",
    trailing: "",
    play: { uris: [`u${i}`] },
  }));

  test("is zero when everything fits", () => {
    expect(windowStart(many.slice(0, 5), 3, 10)).toBe(0);
  });

  test("keeps the selection in view", () => {
    const start = windowStart(many, 20, 10);
    expect(start).toBeLessThanOrEqual(20);
    expect(start + 10).toBeGreaterThan(20);
  });

  test("never scrolls past either end", () => {
    expect(windowStart(many, 0, 10)).toBe(0);
    expect(windowStart(many, 29, 10)).toBe(20);
  });

  test("handles a nonpositive height", () => {
    expect(windowStart(many, 5, 0)).toBe(0);
  });
});
