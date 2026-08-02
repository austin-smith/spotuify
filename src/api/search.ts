import type { SpotifyClient } from "./client.ts";
import { eligibleSearchTypes } from "./search-query.ts";
import type {
  Episode,
  Page,
  SimpleAlbum,
  SimpleArtist,
  SimpleAudiobook,
  SimpleShow,
  Track,
} from "./types.ts";

export interface SimplePlaylist {
  id: string;
  name: string;
  uri: string;
  /** `id` is what decides whether the playlist can be opened; only the owner's own can. */
  owner?: { id?: string; display_name: string | null };
  tracks?: { total: number };
}

export type SearchType =
  | "track"
  | "artist"
  | "album"
  | "playlist"
  | "show"
  | "episode"
  | "audiobook";

export type SearchCategory = "tracks" | "artists" | "albums" | "playlists";
export type SearchScope = "all" | "track" | "artist" | "album" | "playlist";

export const SEARCH_PAGE_SIZE = 10;
const SEARCH_MAX_OFFSET = 1_000;
export const MAX_RESULTS_PER_TYPE = 50;

export const SEARCH_SCOPES: readonly SearchScope[] = [
  "all",
  "track",
  "artist",
  "album",
  "playlist",
];

export const SEARCH_SCOPE_LABEL: Record<SearchScope, string> = {
  all: "ALL",
  track: "TRACKS",
  artist: "ARTISTS",
  album: "ALBUMS",
  playlist: "PLAYLISTS",
};

const TYPE_CATEGORY: Record<Exclude<SearchScope, "all">, SearchCategory> = {
  track: "tracks",
  artist: "artists",
  album: "albums",
  playlist: "playlists",
};

const RESULT_KEY = {
  track: "tracks",
  artist: "artists",
  album: "albums",
  playlist: "playlists",
  show: "shows",
  episode: "episodes",
  audiobook: "audiobooks",
} as const satisfies Record<SearchType, keyof SearchResults>;

const DEFAULT_TYPES: readonly SearchType[] = ["track", "artist", "album", "playlist"];

export interface SearchPageState {
  /** Count currently loaded into this result group. */
  loaded: number;
  /** Total reported by Spotify for the query and category. */
  total: number;
  /** Offset to request next, or null when the group is complete. */
  nextOffset: number | null;
  loadingMore?: boolean;
  loadMoreError?: string;
}

export interface SearchResults {
  tracks: Track[];
  artists: SimpleArtist[];
  albums: SimpleAlbum[];
  playlists: SimplePlaylist[];
  shows: SimpleShow[];
  episodes: Episode[];
  audiobooks: SimpleAudiobook[];
  /** Present only for the four catalog categories requested by the palette. */
  pages?: Partial<Record<SearchCategory, SearchPageState>>;
}

interface RawSearchResponse {
  tracks?: Page<Track | null>;
  artists?: Page<SimpleArtist | null>;
  albums?: Page<SimpleAlbum | null>;
  playlists?: Page<SimplePlaylist | null>;
  shows?: Page<SimpleShow | null>;
  episodes?: Page<Episode | null>;
  audiobooks?: Page<SimpleAudiobook | null>;
}

export interface SearchOptions {
  market?: string;
  signal?: AbortSignal;
  /** Palette scope. Mutually exclusive with `types` and `limit`. */
  scope?: SearchScope;
  /** Palette page offset. Mutually exclusive with `types` and `limit`. */
  offset?: number;
  /** Explicit resource types for CLI search. */
  types?: readonly SearchType[];
  /** CLI result count per requested type; values above one page are fetched incrementally. */
  limit?: number;
}

/** Spotify returns `null` entries inside these arrays; drop them before anything touches a field. */
function compact<T>(page: Page<T | null> | undefined): T[] {
  return (page?.items ?? []).filter((item): item is T => item !== null && item !== undefined);
}

function emptyResults(): SearchResults {
  return {
    tracks: [],
    artists: [],
    albums: [],
    playlists: [],
    shows: [],
    episodes: [],
    audiobooks: [],
  };
}

function pageState<T>(page: Page<T | null> | undefined, loaded: number): SearchPageState {
  const offset = page?.offset ?? 0;
  const total = Math.max(page?.total ?? loaded, loaded);
  // Advance by the page size we requested instead of trusting a malformed response limit. This
  // also guarantees that an actionable next page can never repeat the same offset forever.
  const consumed = offset + SEARCH_PAGE_SIZE;
  return {
    loaded,
    total,
    nextOffset:
      typeof page?.next === "string" && consumed < total && consumed <= SEARCH_MAX_OFFSET
        ? consumed
        : null,
  };
}

export const EMPTY_RESULTS: SearchResults = emptyResults();

async function searchExplicitTypes(
  client: SpotifyClient,
  query: string,
  options: SearchOptions,
): Promise<SearchResults> {
  const types = options.types === undefined ? DEFAULT_TYPES : [...new Set(options.types)];
  if (types.length === 0) return emptyResults();

  const target = options.limit ?? SEARCH_PAGE_SIZE;
  const results = emptyResults();
  // One offset walks every requested type together; a type that is exhausted simply drops out
  // while the others continue. Spotify applies its ten-result request cap independently per type.
  let pending = new Set(types);
  for (let offset = 0; pending.size > 0 && offset < target; offset += SEARCH_PAGE_SIZE) {
    const raw = await client.request<RawSearchResponse>("/search", {
      query: {
        q: query,
        type: [...pending].join(","),
        limit: Math.min(SEARCH_PAGE_SIZE, target - offset),
        ...(offset > 0 ? { offset } : {}),
        market: options.market,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (raw === null) break;

    const still = new Set<SearchType>();
    for (const type of pending) {
      const key = RESULT_KEY[type];
      const page = raw[key] as Page<never> | undefined;
      const kept = target - results[key].length;
      (results[key] as unknown[]).push(...compact(page).slice(0, Math.max(0, kept)));
      if (results[key].length < target && typeof page?.next === "string") still.add(type);
    }
    pending = still;
  }

  return results;
}

async function searchPalettePage(
  client: SpotifyClient,
  query: string,
  options: SearchOptions,
): Promise<SearchResults> {
  const scope = options.scope ?? "all";
  const types = eligibleSearchTypes(scope, query);
  const raw = await client.request<RawSearchResponse>("/search", {
    query: {
      q: query,
      type: types.join(","),
      limit: SEARCH_PAGE_SIZE,
      offset: options.offset,
      market: options.market,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (raw === null) return emptyResults();
  // Validate the response boundary too; a malformed or future API response cannot silently break
  // the ten-per-category palette contract.
  const pages: NonNullable<SearchResults["pages"]> = {};
  const results: SearchResults = {
    tracks: compact(raw.tracks).slice(0, SEARCH_PAGE_SIZE),
    artists: compact(raw.artists).slice(0, SEARCH_PAGE_SIZE),
    albums: compact(raw.albums).slice(0, SEARCH_PAGE_SIZE),
    playlists: compact(raw.playlists).slice(0, SEARCH_PAGE_SIZE),
    shows: [],
    episodes: [],
    audiobooks: [],
    pages,
  };

  for (const type of types) {
    const category = TYPE_CATEGORY[type];
    switch (category) {
      case "tracks":
        pages.tracks = pageState(raw.tracks, results.tracks.length);
        break;
      case "artists":
        pages.artists = pageState(raw.artists, results.artists.length);
        break;
      case "albums":
        pages.albums = pageState(raw.albums, results.albums.length);
        break;
      case "playlists":
        pages.playlists = pageState(raw.playlists, results.playlists.length);
        break;
    }
  }

  return results;
}

/**
 * Search Spotify for either one palette page or an explicit CLI result set.
 *
 * Palette callers use `scope`/`offset`; CLI callers use `types`/`limit`. Keeping those modes
 * explicit prevents UI pagination state from leaking into the broader command-line search API.
 */
export async function search(
  client: SpotifyClient,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResults> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return emptyResults();
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_RESULTS_PER_TYPE)
  ) {
    throw new Error(`search limit must be between 1 and ${MAX_RESULTS_PER_TYPE}`);
  }

  const explicitTypeMode = options.types !== undefined || options.limit !== undefined;
  if (explicitTypeMode && (options.scope !== undefined || options.offset !== undefined)) {
    throw new Error("search types/limit cannot be combined with scope/offset");
  }
  return explicitTypeMode
    ? await searchExplicitTypes(client, trimmed, options)
    : await searchPalettePage(client, trimmed, options);
}

export function scopeForCategory(category: SearchCategory): Exclude<SearchScope, "all"> {
  switch (category) {
    case "tracks":
      return "track";
    case "artists":
      return "artist";
    case "albums":
      return "album";
    case "playlists":
      return "playlist";
  }
}
