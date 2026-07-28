import type { AlbumTrack } from "../api/catalog.ts";
import type { HomeData } from "../api/library.ts";
import type { SearchResults, SimplePlaylist } from "../api/search.ts";
import { artistLine, type SimpleAlbum, type SimpleArtist, type Track } from "../api/types.ts";
import { formatDuration } from "./progress.ts";

/**
 * A rendered palette line.
 *
 * Headers and results share one flat list so the view can render it top to bottom while navigation
 * still only lands on selectable rows.
 */
export type Row =
  | { kind: "header"; label: string }
  | {
      kind: "result";
      label: string;
      detail: string;
      trailing: string;
      /** What to hand the player when this row is chosen. */
      play: PlayTarget;
      /** Set when choosing this row should open a deeper list rather than play. */
      drill?: Drill;
    };

export type PlayTarget =
  | { uris: string[] }
  /** `offset` starts a context part-way in, so picking track 4 keeps playing 5, 6, 7… */
  | { contextUri: string; offset?: number };

export type Drill =
  | { kind: "artist"; id: string; name: string }
  | { kind: "album"; id: string; name: string; uri: string };

type ResultRow = Extract<Row, { kind: "result" }>;

function trackRow(track: Track): ResultRow {
  return {
    kind: "result",
    label: track.name,
    detail: artistLine(track),
    trailing: formatDuration(track.duration_ms),
    play: { uris: [track.uri] },
  };
}

function artistRow(artist: SimpleArtist): ResultRow {
  return {
    kind: "result",
    label: artist.name,
    detail: "",
    trailing: "",
    play: { contextUri: artist.uri },
    drill: { kind: "artist", id: artist.id, name: artist.name },
  };
}

function albumRow(album: SimpleAlbum): ResultRow {
  const year = album.release_date?.slice(0, 4) ?? "";
  const tracks = album.total_tracks === undefined ? "" : `${album.total_tracks} tracks`;
  return {
    kind: "result",
    label: album.name,
    detail: [year, tracks].filter((part) => part.length > 0).join(" · "),
    trailing: "",
    play: { contextUri: album.uri },
    drill: { kind: "album", id: album.id, name: album.name, uri: album.uri },
  };
}

/** Playlists carry no track count for us — neither search nor `/me/playlists` returns one. */
function playlistRow(playlist: SimplePlaylist): ResultRow {
  return {
    kind: "result",
    label: playlist.name,
    detail: playlist.owner?.display_name ?? "",
    trailing: "",
    play: { contextUri: playlist.uri },
  };
}

/**
 * Rows for an album's own track list.
 *
 * Album tracks arrive simplified, with no `album` field, so the parent album is passed in to build
 * the play target. Each row starts the album at its own position rather than playing one track
 * alone, so the album continues afterwards.
 */
export function toAlbumRows(album: { name: string; uri: string }, tracks: AlbumTrack[]): Row[] {
  return tracks.map((track, index) => ({
    kind: "result" as const,
    label: `${String(track.track_number || index + 1).padStart(2)}  ${track.name}`,
    detail: track.artists.map((a) => a.name).join(", "),
    trailing: formatDuration(track.duration_ms),
    play: { contextUri: album.uri, offset: index },
  }));
}

/** Rows for an artist's releases. */
export function toArtistRows(albums: SimpleAlbum[]): Row[] {
  return albums.map(albumRow);
}

/** Case-insensitive substring filter over selectable rows, dropping headers left empty. */
export function filterRows(rows: Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;

  const kept: Row[] = [];
  for (const row of rows) {
    if (row.kind === "header") {
      kept.push(row);
      continue;
    }
    if (`${row.label} ${row.detail}`.toLowerCase().includes(needle)) kept.push(row);
  }

  // Drop headers whose group ended up empty.
  return kept.filter((row, i) => {
    if (row.kind !== "header") return true;
    return kept[i + 1]?.kind === "result";
  });
}

/** A header plus its rows, or nothing at all when the group is empty. */
function group<T>(label: string, items: T[], toRow: (item: T) => ResultRow): Row[] {
  if (items.length === 0) return [];
  return [{ kind: "header", label }, ...items.map(toRow)];
}

/** Flatten grouped search results into display order, omitting empty groups. */
export function toRows(results: SearchResults): Row[] {
  return [
    ...group("TRACKS", results.tracks, trackRow),
    ...group("ARTISTS", results.artists, artistRow),
    ...group("ALBUMS", results.albums, albumRow),
    ...group("PLAYLISTS", results.playlists, playlistRow),
  ];
}

/** What the palette lists before anything is typed. */
export function toHomeRows(home: HomeData): Row[] {
  return [
    ...group("RECENTLY PLAYED", home.recent, trackRow),
    ...group("YOUR TOP TRACKS", home.top, trackRow),
  ];
}

/** Index of the first selectable row, or -1 when there are none. */
export function firstSelectable(rows: Row[]): number {
  return rows.findIndex((row) => row.kind === "result");
}

/**
 * Move the selection by `delta`, skipping headers and stopping at the ends.
 *
 * Deliberately does not wrap: wrapping from the last result back to the first makes a long list
 * feel like it lost your place.
 */
export function moveSelection(rows: Row[], current: number, delta: number): number {
  const step = delta > 0 ? 1 : -1;
  let remaining = Math.abs(delta);
  let index = current;

  while (remaining > 0) {
    let next = index + step;
    while (next >= 0 && next < rows.length && rows[next]?.kind !== "result") next += step;
    if (next < 0 || next >= rows.length) break;
    index = next;
    remaining--;
  }

  return rows[index]?.kind === "result" ? index : firstSelectable(rows);
}

/**
 * Rows visible in a window of `height`, keeping `selected` in view.
 *
 * Returns the slice start so the caller can render `rows.slice(start, start + height)`.
 */
export function windowStart(rows: Row[], selected: number, height: number): number {
  if (rows.length <= height || height <= 0) return 0;
  // Keep the selection roughly centred, then clamp so the window never runs past either end.
  const ideal = selected - Math.floor(height / 2);
  return Math.min(Math.max(0, ideal), rows.length - height);
}
