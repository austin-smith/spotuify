import { describe, expect, test } from "bun:test";
import type { AlbumTrack } from "../src/api/catalog.ts";
import type { SimpleAlbum } from "../src/api/types.ts";
import { filterRows, toAlbumRows, toArtistRows, toRows, type Row } from "../src/store/rows.ts";

const albumTrack = (n: number, name: string): AlbumTrack => ({
  id: String(n),
  name,
  uri: `spotify:track:${n}`,
  duration_ms: 200_000 + n,
  track_number: n,
  artists: [{ id: "a", name: "The National", uri: "spotify:artist:a" }],
});

const album = (over: Partial<SimpleAlbum> = {}): SimpleAlbum => ({
  id: "b",
  name: "Boxer",
  uri: "spotify:album:b",
  images: [],
  release_date: "2007-05-22",
  total_tracks: 12,
  ...over,
});

const results = (rows: Row[]) => rows.filter((r) => r.kind === "result");

describe("toAlbumRows", () => {
  const rows = toAlbumRows({ name: "Boxer", uri: "spotify:album:b" }, [
    albumTrack(1, "Fake Empire"),
    albumTrack(2, "Mistaken for Strangers"),
  ]);

  test("is all selectable rows, no header", () => {
    expect(rows.every((r) => r.kind === "result")).toBe(true);
  });

  test("numbers each track", () => {
    expect(rows[0]?.kind === "result" && rows[0].label).toContain("1");
    expect(rows[0]?.kind === "result" && rows[0].label).toContain("Fake Empire");
  });

  // Playing a lone track uri would stop after it; the album as context keeps going.
  test("plays the album as context, offset to the chosen track", () => {
    expect(results(rows)[0]).toMatchObject({
      play: { contextUri: "spotify:album:b", offset: 0 },
    });
    expect(results(rows)[1]).toMatchObject({
      play: { contextUri: "spotify:album:b", offset: 1 },
    });
  });

  test("shows durations", () => {
    expect(results(rows)[0]?.trailing).toBe("3:20");
  });

  test("never offers a further drill", () => {
    expect(results(rows).every((r) => r.drill === undefined)).toBe(true);
  });

  test("falls back to position when track_number is missing", () => {
    const odd = toAlbumRows({ name: "X", uri: "u" }, [
      { ...albumTrack(1, "One"), track_number: 0 },
    ]);
    expect(odd[0]?.kind === "result" && odd[0].label).toContain("1");
  });

  test("handles an empty album", () => {
    expect(toAlbumRows({ name: "X", uri: "u" }, [])).toEqual([]);
  });
});

describe("toArtistRows", () => {
  test("each album can be drilled into", () => {
    const rows = toArtistRows([album(), album({ id: "c", name: "High Violet" })]);
    expect(results(rows)).toHaveLength(2);
    expect(results(rows)[0]?.drill).toEqual({
      kind: "album",
      id: "b",
      name: "Boxer",
      uri: "spotify:album:b",
    });
  });

  // Live albums and expanded editions come through regardless of include_groups; the year and
  // track count are what distinguish them.
  test("shows year and track count", () => {
    expect(results(toArtistRows([album()]))[0]?.detail).toBe("2007 · 12 tracks");
  });
});

describe("drill targets in search results", () => {
  const rows = toRows({
    tracks: [
      {
        id: "t",
        name: "Fake Empire",
        uri: "spotify:track:t",
        duration_ms: 200_000,
        artists: [{ id: "a", name: "The National", uri: "spotify:artist:a" }],
        album: album(),
      },
    ],
    artists: [{ id: "a", name: "The National", uri: "spotify:artist:a" }],
    albums: [album()],
    playlists: [{ id: "p", name: "Mix", uri: "spotify:playlist:p" }],
  });

  test("artists and albums drill, tracks and playlists do not", () => {
    const byLabel = new Map(results(rows).map((r) => [r.label, r]));
    expect(byLabel.get("Fake Empire")?.drill).toBeUndefined();
    expect(byLabel.get("Mix")?.drill).toBeUndefined();
    expect(byLabel.get("The National")?.drill).toMatchObject({ kind: "artist" });
    expect(byLabel.get("Boxer")?.drill).toMatchObject({ kind: "album" });
  });
});

describe("filterRows", () => {
  const rows = toRows({
    tracks: [
      {
        id: "1",
        name: "Fake Empire",
        uri: "u1",
        duration_ms: 1000,
        artists: [{ id: "a", name: "The National", uri: "u" }],
        album: album(),
      },
      {
        id: "2",
        name: "Brainy",
        uri: "u2",
        duration_ms: 1000,
        artists: [{ id: "a", name: "The National", uri: "u" }],
        album: album(),
      },
    ],
    artists: [],
    albums: [album({ name: "High Violet" })],
    playlists: [],
  });

  test("returns everything for a blank filter", () => {
    expect(filterRows(rows, "   ")).toEqual(rows);
  });

  test("matches the label, case-insensitively", () => {
    expect(results(filterRows(rows, "FAKE")).map((r) => r.label)).toEqual(["Fake Empire"]);
  });

  test("matches the detail column too", () => {
    // "national" appears only in the artist detail, not any label.
    expect(results(filterRows(rows, "national")).map((r) => r.label)).toEqual([
      "Fake Empire",
      "Brainy",
    ]);
  });

  test("drops headers left with no rows", () => {
    const filtered = filterRows(rows, "high violet");
    const headers = filtered.filter((r) => r.kind === "header");
    expect(headers.map((h) => (h as { label: string }).label)).toEqual(["ALBUMS"]);
  });

  test("can filter everything out", () => {
    expect(filterRows(rows, "zzzzz")).toEqual([]);
  });

  test("never leaves a trailing orphan header", () => {
    const filtered = filterRows(rows, "brainy");
    expect(filtered.at(-1)?.kind).toBe("result");
  });
});
