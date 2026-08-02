import type { SpotifyClient } from "./client.ts";
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

export interface SearchResults {
  tracks: Track[];
  artists: SimpleArtist[];
  albums: SimpleAlbum[];
  playlists: SimplePlaylist[];
  shows: SimpleShow[];
  episodes: Episode[];
  audiobooks: SimpleAudiobook[];
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

const RESULT_KEY = {
  track: "tracks",
  artist: "artists",
  album: "albums",
  playlist: "playlists",
  show: "shows",
  episode: "episodes",
  audiobook: "audiobooks",
} as const satisfies Record<SearchType, keyof SearchResults>;

/** The palette's default request: the four types it renders, unpaged. */
const DEFAULT_TYPES: readonly SearchType[] = ["track", "artist", "album", "playlist"];

/**
 * Per-type result counts for the default (palette) search.
 *
 * Spotify caps `limit` at 10 per type — `limit=20` is a hard 400 `Invalid limit`, not a silent
 * clamp. Deeper result sets are reached by paging `offset`, which `search` does only when a caller
 * asks for more than one request's worth.
 */
export const PER_TYPE = { tracks: 6, artists: 4, albums: 4, playlists: 4 } as const;
const MAX_LIMIT = 10;

/** Spotify rejects `offset` beyond 1000; combined with a 50-per-type cap this is unreachable. */
export const MAX_RESULTS_PER_TYPE = 50;

/** Spotify returns `null` entries inside these arrays; drop them before anything touches a field. */
function compact<T>(page: Page<T | null> | undefined): T[] {
  return (page?.items ?? []).filter((item): item is T => item !== null && item !== undefined);
}

export const EMPTY_RESULTS: SearchResults = {
  tracks: [],
  artists: [],
  albums: [],
  playlists: [],
  shows: [],
  episodes: [],
  audiobooks: [],
};

export async function search(
  client: SpotifyClient,
  query: string,
  options: {
    market?: string;
    signal?: AbortSignal;
    /** Resource types to request. Defaults to the palette's four. */
    types?: readonly SearchType[];
    /**
     * Per-type result count, 1–50. Without it the palette's `PER_TYPE` caps apply; with it every
     * requested type is paged until it has `limit` results or Spotify runs out.
     */
    limit?: number;
  } = {},
): Promise<SearchResults> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return EMPTY_RESULTS;
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_RESULTS_PER_TYPE)
  ) {
    throw new Error(`search limit must be between 1 and ${MAX_RESULTS_PER_TYPE}`);
  }

  const types = options.types === undefined ? DEFAULT_TYPES : [...new Set(options.types)];
  if (types.length === 0) return EMPTY_RESULTS;
  const perType = (type: SearchType): number =>
    options.limit ?? PER_TYPE[RESULT_KEY[type] as keyof typeof PER_TYPE] ?? MAX_LIMIT;
  const target = Math.max(...types.map(perType));

  const results: SearchResults = {
    tracks: [],
    artists: [],
    albums: [],
    playlists: [],
    shows: [],
    episodes: [],
    audiobooks: [],
  };
  // One offset walks every requested type together; a type that is exhausted simply returns an
  // empty page while the others keep filling. Spotify's per-request cap makes this the only way
  // past 10 results.
  let pending = new Set(types);
  for (let offset = 0; pending.size > 0 && offset < target; offset += MAX_LIMIT) {
    const raw = await client.request<RawSearchResponse>("/search", {
      query: {
        q: trimmed,
        type: [...pending].join(","),
        limit: Math.min(MAX_LIMIT, target - offset),
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
      const kept = perType(type) - results[key].length;
      (results[key] as unknown[]).push(...compact(page).slice(0, Math.max(0, kept)));
      if (results[key].length < perType(type) && typeof page?.next === "string") still.add(type);
    }
    pending = still;
  }

  return results;
}
