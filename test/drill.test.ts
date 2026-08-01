import { describe, expect, test } from "bun:test";
import type { AlbumTrack } from "../src/api/catalog.ts";
import { EMPTY_RESULTS } from "../src/api/search.ts";
import type { SimpleAlbum } from "../src/api/types.ts";
import {
  filterRows,
  matchPlaylists,
  toAlbumRows,
  toArtistRows,
  toHomeRows,
  toPlaylistRows,
  toRows,
  type Row,
} from "../src/store/rows.ts";

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
    ...EMPTY_RESULTS,
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
    ...EMPTY_RESULTS,
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

describe("playlist rows", () => {
  const owned = {
    id: "p1",
    name: "DRV",
    uri: "spotify:playlist:p1",
    ownerId: "me",
    ownerName: "me",
    mine: true,
  };
  const followed = { ...owned, id: "p2", name: "This is The Strokes", ownerName: "manuchabu", ownerId: "manuchabu", mine: false };

  /**
   * Spotify answers 403 for the contents of any playlist the user does not own, so offering to open
   * one is offering a dead end.
   */
  test("only the user's own playlists can be opened", () => {
    const rows = toHomeRows({ recent: [], top: [], playlists: [owned, followed] });
    const byLabel = new Map(results(rows).map((r) => [r.label, r]));
    expect(byLabel.get("DRV")?.drill).toEqual({
      kind: "playlist",
      id: "p1",
      name: "DRV",
      uri: "spotify:playlist:p1",
    });
    expect(byLabel.get("This is The Strokes")?.drill).toBeUndefined();
  });

  // The owner doubles as the reason that row will not open.
  test("names the owner only when it is someone else", () => {
    const rows = toHomeRows({ recent: [], top: [], playlists: [owned, followed] });
    const byLabel = new Map(results(rows).map((r) => [r.label, r]));
    expect(byLabel.get("DRV")?.detail).toBe("");
    expect(byLabel.get("This is The Strokes")?.detail).toBe("manuchabu");
  });

  test("every playlist still plays as a context", () => {
    const rows = toHomeRows({ recent: [], top: [], playlists: [followed] });
    expect(results(rows)[0]).toMatchObject({ play: { contextUri: "spotify:playlist:p1" } });
  });

  test("a search hit is openable when the owner is us", () => {
    const rows = toRows(
      {
        ...EMPTY_RESULTS,
        playlists: [
          { id: "s1", name: "Mine", uri: "u1", owner: { id: "me", display_name: "me" } },
          { id: "s2", name: "Theirs", uri: "u2", owner: { id: "other", display_name: "Other" } },
        ],
      },
      { meId: "me", libraryMatches: [] },
    );
    const byLabel = new Map(results(rows).map((r) => [r.label, r]));
    expect(byLabel.get("Mine")?.drill).toMatchObject({ kind: "playlist" });
    expect(byLabel.get("Theirs")?.drill).toBeUndefined();
  });

  // Spotify's playlist search returns mostly nulls and other people's playlists, so the user's own
  // matches lead — they are the only ones that open.
  test("the user's own matches lead the results", () => {
    const rows = toRows(
      { ...EMPTY_RESULTS },
      { meId: "me", libraryMatches: [owned] },
    );
    expect(rows[0]).toMatchObject({ kind: "header", label: "YOUR PLAYLISTS" });
    expect(results(rows)[0]?.drill).toMatchObject({ kind: "playlist" });
  });

  test("does not repeat a library playlist returned by remote search", () => {
    const rows = toRows(
      {
        ...EMPTY_RESULTS,
        playlists: [
          {
            id: owned.id,
            name: owned.name,
            uri: owned.uri,
            owner: { id: "me", display_name: "me" },
          },
        ],
      },
      { meId: "me", libraryMatches: [owned] },
    );
    expect(results(rows).filter((row) => row.label === owned.name)).toHaveLength(1);
  });
});

describe("toPlaylistRows", () => {
  const entry = (position: number, name: string) => ({
    position,
    isLocal: false,
    item: {
      id: name,
      name,
      uri: `spotify:track:${name}`,
      duration_ms: 200_000,
      artists: [{ id: "a", name: "The National", uri: "spotify:artist:a" }],
      album: album(),
    },
  });

  const playlist = { name: "DRV", uri: "spotify:playlist:p1" };

  test("plays the playlist as context, offset to the chosen track", () => {
    const rows = toPlaylistRows(playlist, [entry(0, "One"), entry(1, "Two")]);
    expect(results(rows)[0]).toMatchObject({
      play: { contextUri: "spotify:playlist:p1", offset: 0 },
    });
    expect(results(rows)[1]).toMatchObject({
      play: { contextUri: "spotify:playlist:p1", offset: 1 },
    });
  });

  /**
   * The offset is the position within the playlist, not the index in this array. An entry dropped
   * for being a podcast still occupies a slot in the context, and ignoring that starts the wrong
   * song for every row after it.
   */
  test("uses the entry's position, not its index", () => {
    const rows = toPlaylistRows(playlist, [entry(0, "One"), entry(7, "Eight")]);
    expect(results(rows)[1]).toMatchObject({
      play: { contextUri: "spotify:playlist:p1", offset: 7 },
    });
  });

  test("shows the artist and duration", () => {
    const rows = toPlaylistRows(playlist, [entry(0, "One")]);
    expect(results(rows)[0]?.detail).toBe("The National");
    expect(results(rows)[0]?.trailing).toBe("3:20");
  });

  test("never offers a further drill", () => {
    const rows = toPlaylistRows(playlist, [entry(0, "One")]);
    expect(results(rows).every((r) => r.drill === undefined)).toBe(true);
  });

  test("handles an empty playlist", () => {
    expect(toPlaylistRows(playlist, [])).toEqual([]);
  });
});

describe("matchPlaylists", () => {
  const list = (name: string) => ({
    id: name,
    name,
    uri: `spotify:playlist:${name}`,
    ownerId: "me",
    ownerName: "me",
    mine: true,
  });
  const all = [list("Late Night Drive"), list("Morning"), list("driving songs")];

  test("matches case-insensitively anywhere in the name", () => {
    expect(matchPlaylists(all, "driv").map((p) => p.name)).toEqual([
      "Late Night Drive",
      "driving songs",
    ]);
  });

  test("matches nothing for a blank query", () => {
    expect(matchPlaylists(all, "   ")).toEqual([]);
  });

  test("caps how many it returns", () => {
    expect(matchPlaylists([list("a1"), list("a2"), list("a3")], "a", 2)).toHaveLength(2);
  });

  test("prioritizes openable owned playlists before applying the cap", () => {
    const followed = Array.from({ length: 5 }, (_, index) => ({
      ...list(`drive followed ${index}`),
      ownerId: "other",
      ownerName: "other",
      mine: false,
    }));
    const owned = list("drive mine");

    const matches = matchPlaylists([...followed, owned], "drive", 5);
    expect(matches[0]?.name).toBe("drive mine");
    expect(matches).toHaveLength(5);
  });
});
