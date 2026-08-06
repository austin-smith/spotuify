import type { AlbumTrack } from "../api/catalog.ts";
import type { HomeData } from "../api/library.ts";
import type { Playlist, PlaylistEntry } from "../api/playlists.ts";
import type { ResolvedSpotifyReference } from "../api/references.ts";
import {
  SEARCH_PAGE_SIZE,
  type SearchCategory,
  type SearchPageState,
  type SearchResults,
  type SimplePlaylist,
} from "../api/search.ts";
import {
  artistLine,
  type PlayableItem,
  type SimpleAlbum,
  type SimpleArtist,
  type Track,
} from "../api/types.ts";
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
      /** Canonical Spotify identity used by copy/link actions. */
      referenceUri: string;
      /** What to hand the player when this row is chosen. */
      play: PlayTarget;
      /** Full item context for save and add-to-playlist actions, when this is a playable item. */
      actionItem?: PlayableItem;
      /** Set when choosing this row should open a deeper list rather than play. */
      drill?: Drill;
    }
  | {
      kind: "more";
      category: SearchCategory;
      label: string;
      detail: string;
      loading: boolean;
      error: boolean;
    };

export type PlayTarget =
  | { uris: string[] }
  /** `offset` starts a context part-way in, so picking track 4 keeps playing 5, 6, 7… */
  | { contextUri: string; offset?: number };

export type Drill =
  | { kind: "artist"; id: string; name: string }
  | { kind: "album"; id: string; name: string; uri: string }
  | { kind: "playlist"; id: string; name: string; uri: string };

/**
 * What the row builders need to know about the signed-in user.
 *
 * Only playlist rows care, and only because Spotify refuses to list the contents of a playlist the
 * user does not own — so ownership is what decides whether a row opens or merely plays.
 */
export interface RowContext {
  meId: string;
  /**
   * Playlists from the user's library matching the current query, with owned playlists first.
   *
   * Surfaced above Spotify's results because playlist search is close to useless: it returns mostly
   * `null` entries, and the survivors belong to other people and cannot be opened.
   */
  libraryMatches: Playlist[];
}

export const EMPTY_CONTEXT: RowContext = { meId: "", libraryMatches: [] };

type ResultRow = Extract<Row, { kind: "result" }>;
export type SelectableRow = Extract<Row, { kind: "result" | "more" }>;

export function isSelectable(row: Row | undefined): row is SelectableRow {
  return row?.kind === "result" || row?.kind === "more";
}

function trackRow(track: Track): ResultRow {
  return {
    kind: "result",
    label: track.name,
    detail: artistLine(track),
    trailing: formatDuration(track.duration_ms),
    referenceUri: track.uri,
    play: { uris: [track.uri] },
    actionItem: track,
  };
}

function artistRow(artist: SimpleArtist): ResultRow {
  return {
    kind: "result",
    label: artist.name,
    detail: "",
    trailing: "",
    referenceUri: artist.uri,
    play: { contextUri: artist.uri },
    drill: { kind: "artist", id: artist.id, name: artist.name },
  };
}

function albumRow(album: SimpleAlbum, options: { showArtist?: boolean } = {}): ResultRow {
  const year = album.release_date?.slice(0, 4) ?? "";
  const tracks = album.total_tracks === undefined ? "" : `${album.total_tracks} tracks`;
  const artists = album.artists?.map((artist) => artist.name).join(", ") ?? "";
  return {
    kind: "result",
    label: album.name,
    detail: options.showArtist === true && artists.length > 0
      ? artists
      : [year, tracks].filter((part) => part.length > 0).join(" · "),
    trailing: options.showArtist === true ? year : "",
    referenceUri: album.uri,
    play: { contextUri: album.uri },
    drill: { kind: "album", id: album.id, name: album.name, uri: album.uri },
  };
}

/**
 * A playlist row, openable only when the user owns it.
 *
 * Playlists carry no track count — neither search nor `/me/playlists` returns one any more. The
 * owner is shown instead for playlists belonging to someone else, which doubles as the reason that
 * row cannot be opened.
 */
function playlistRow(playlist: {
  id: string;
  name: string;
  uri: string;
  ownerName: string;
  mine: boolean;
}, options: { showOwner?: boolean } = {}): ResultRow {
  return {
    kind: "result",
    label: playlist.name,
    detail: options.showOwner === true || !playlist.mine ? playlist.ownerName : "",
    trailing: "",
    referenceUri: playlist.uri,
    play: { contextUri: playlist.uri },
    ...(playlist.mine
      ? {
          drill: {
            kind: "playlist" as const,
            id: playlist.id,
            name: playlist.name,
            uri: playlist.uri,
          },
        }
      : {}),
  };
}

/** Complete playlist-library rows, including the owner column for every entry. */
export function toLibraryPlaylistRows(playlists: Playlist[]): Row[] {
  return playlists.map((playlist) => playlistRow(playlist, { showOwner: true }));
}

/** Complete saved-album rows. */
export function toLibraryAlbumRows(albums: SimpleAlbum[]): Row[] {
  return albums.map((album) => albumRow(album, { showArtist: true }));
}

/** Complete followed-artist rows. */
export function toLibraryArtistRows(artists: SimpleArtist[]): Row[] {
  return artists.map(artistRow);
}

/** A search hit, which reports its owner but not whether that owner is us. */
function searchPlaylistRow(playlist: SimplePlaylist, meId: string): ResultRow {
  const ownerId = playlist.owner?.id ?? "";
  return playlistRow({
    id: playlist.id,
    name: playlist.name,
    uri: playlist.uri,
    ownerName: playlist.owner?.display_name ?? ownerId,
    mine: ownerId !== "" && ownerId === meId,
  });
}

/**
 * Rows for a playlist's contents.
 *
 * Each row starts the playlist at its own position, so choosing track 12 keeps playing 13, 14 and
 * so on. The offset is the entry's position within the playlist rather than its index in this
 * array — entries skipped for being unreadable still occupy a slot in the context.
 */
export function toPlaylistRows(
  playlist: { name: string; uri: string },
  entries: PlaylistEntry[],
): Row[] {
  return entries.map((entry) => ({
    kind: "result" as const,
    label: entry.item.name,
    detail: artistLine(entry.item),
    trailing: formatDuration(entry.item.duration_ms),
    referenceUri: entry.item.uri,
    play: { contextUri: playlist.uri, offset: entry.position },
    actionItem: entry.item,
  }));
}

/**
 * Rows for an album's own track list.
 *
 * Album tracks arrive simplified, with no `album` field, so the parent album is passed in to build
 * the play target. Each row starts the album at its own position rather than playing one track
 * alone, so the album continues afterwards.
 */
export function toAlbumRows(
  album: { id?: string; name: string; uri: string },
  tracks: AlbumTrack[],
): Row[] {
  const albumId = album.id ?? album.uri.split(":").at(-1) ?? "";
  return tracks.map((track, index) => ({
    kind: "result" as const,
    label: `${String(track.track_number || index + 1).padStart(2)}  ${track.name}`,
    detail: track.artists.map((a) => a.name).join(", "),
    trailing: formatDuration(track.duration_ms),
    referenceUri: track.uri,
    play: { contextUri: album.uri, offset: index },
    actionItem: {
      id: track.id,
      name: track.name,
      uri: track.uri,
      duration_ms: track.duration_ms,
      artists: track.artists,
      album: {
        id: albumId,
        name: album.name,
        uri: album.uri,
        images: [],
      },
    },
  }));
}

/** Rows for an artist's releases. */
export function toArtistRows(albums: SimpleAlbum[]): Row[] {
  return albums.map((album) => albumRow(album));
}

/** A resolved pasted URI/URL is shown as one deliberate, confirmable navigation result. */
export function toReferenceRows(
  resolved: ResolvedSpotifyReference,
  context: RowContext = EMPTY_CONTEXT,
): Row[] {
  switch (resolved.type) {
    case "track":
      return [trackRow(resolved.item)];
    case "artist":
      return [artistRow(resolved.item)];
    case "album":
      return [albumRow(resolved.item)];
    case "playlist":
      return [searchPlaylistRow(resolved.item, context.meId)];
  }
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
    return isSelectable(kept[i + 1]);
  });
}

/** A header plus its rows, or nothing at all when the group is empty. */
function group<T>(
  label: string,
  items: T[],
  toRow: (item: T) => ResultRow,
  pagination?: { category: SearchCategory; page: SearchPageState },
): Row[] {
  if (items.length === 0 && pagination?.page.nextOffset === null) return [];
  if (items.length === 0 && pagination === undefined) return [];

  const rows: Row[] = [
    {
      kind: "header",
      label,
    },
    ...items.map(toRow),
  ];

  const paged = pagination;
  if (paged !== undefined && paged.page.nextOffset !== null) {
    const failed = paged.page.loadMoreError !== undefined;
    rows.push({
      kind: "more",
      category: paged.category,
      label: failed
        ? `↻ retry loading ${paged.category}`
        : paged.page.loadingMore === true
          ? `loading more ${paged.category}…`
          : `load more ${paged.category}…`,
      detail: failed ? paged.page.loadMoreError ?? "" : "",
      loading: paged.page.loadingMore === true,
      error: failed,
    });
  }

  return rows;
}

/**
 * Flatten grouped search results into display order, omitting empty groups.
 *
 * The user's own matching playlists lead, because they are the only playlists in the list that can
 * actually be opened.
 */
export function toRows(results: SearchResults, context: RowContext = EMPTY_CONTEXT): Row[] {
  const libraryPlaylistIds = new Set(context.libraryMatches.map((playlist) => playlist.id));
  const remotePlaylists = results.playlists.filter(
    (playlist) => !libraryPlaylistIds.has(playlist.id),
  );

  return [
    ...group("YOUR PLAYLISTS", context.libraryMatches, (p) => playlistRow(p)),
    ...group(
      "TRACKS",
      results.tracks,
      trackRow,
      results.pages?.tracks === undefined
        ? undefined
        : { category: "tracks", page: results.pages.tracks },
    ),
    ...group(
      "ARTISTS",
      results.artists,
      artistRow,
      results.pages?.artists === undefined
        ? undefined
        : { category: "artists", page: results.pages.artists },
    ),
    ...group(
      "ALBUMS",
      results.albums,
      albumRow,
      results.pages?.albums === undefined
        ? undefined
        : { category: "albums", page: results.pages.albums },
    ),
    ...group(
      "PLAYLISTS",
      remotePlaylists,
      (p) => searchPlaylistRow(p, context.meId),
      results.pages?.playlists === undefined
        ? undefined
        : { category: "playlists", page: results.pages.playlists },
    ),
  ];
}

/**
 * Playlists listed before typing.
 *
 * The store holds every playlist so names can be matched while typing; only the most recently
 * touched few are worth a permanent place on the opening screen.
 */
const HOME_PLAYLISTS = 8;

/** What the palette lists before anything is typed. */
export function toHomeRows(home: HomeData): Row[] {
  return [
    ...group("RECENTLY PLAYED", home.recent, trackRow),
    ...group("YOUR PLAYLISTS", home.playlists.slice(0, HOME_PLAYLISTS), (p) => playlistRow(p)),
    ...group("YOUR TOP TRACKS", home.top, trackRow),
  ];
}

/**
 * The user's playlists whose name matches what they have typed.
 *
 * A plain substring match on the name, which is all the palette's own filter does elsewhere. The
 * default uses the same ten-result page as remote categories; there is no smaller all-scope mode.
 */
export function matchPlaylists(
  playlists: Playlist[],
  query: string,
  limit = SEARCH_PAGE_SIZE,
): Playlist[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const matches = playlists.filter((playlist) =>
    playlist.name.toLowerCase().includes(needle),
  );
  return [
    ...matches.filter((playlist) => playlist.mine),
    ...matches.filter((playlist) => !playlist.mine),
  ].slice(0, limit);
}

/** Index of the first selectable row, or -1 when there are none. */
export function firstSelectable(rows: Row[]): number {
  return rows.findIndex(isSelectable);
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
    while (next >= 0 && next < rows.length && !isSelectable(rows[next])) next += step;
    if (next < 0 || next >= rows.length) break;
    index = next;
    remaining--;
  }

  return isSelectable(rows[index]) ? index : firstSelectable(rows);
}

/** Move by rendered rows, then land on the nearest selectable row in that direction. */
export function moveSelectionPage(
  rows: Row[],
  current: number,
  direction: -1 | 1,
  pageSize: number,
): number {
  if (!isSelectable(rows[current])) return firstSelectable(rows);

  const distance = Math.max(1, Math.floor(pageSize));
  const target = Math.min(
    rows.length - 1,
    Math.max(0, current + direction * distance),
  );
  if (isSelectable(rows[target])) return target;

  for (
    let index = target + direction;
    index >= 0 && index < rows.length;
    index += direction
  ) {
    if (isSelectable(rows[index])) return index;
  }
  for (
    let index = target - direction;
    index >= 0 && index < rows.length;
    index -= direction
  ) {
    if (isSelectable(rows[index])) return index;
  }
  return firstSelectable(rows);
}

/**
 * Rows visible in a window of `height`, keeping `selected` in view.
 *
 * Returns the slice start so the caller can render `rows.slice(start, start + height)`.
 */
export function windowStart(rows: Row[], selected: number, height: number): number {
  return listWindowStart(rows.length, selected, height);
}

/** Generic list windowing for overlays whose rows are not palette `Row`s. */
export function listWindowStart(length: number, selected: number, height: number): number {
  if (length <= height || height <= 0) return 0;
  // Keep the selection roughly centered, then clamp so the window never runs past either end.
  const ideal = selected - Math.floor(height / 2);
  return Math.min(Math.max(0, ideal), length - height);
}
