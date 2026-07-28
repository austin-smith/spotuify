import type { SpotifyClient } from "./client.ts";
import type { Page, SimpleAlbum, SimpleArtist, Track } from "./types.ts";

export interface SimplePlaylist {
  id: string;
  name: string;
  uri: string;
  owner?: { display_name: string | null };
  tracks?: { total: number };
}

export interface SearchResults {
  tracks: Track[];
  artists: SimpleArtist[];
  albums: SimpleAlbum[];
  playlists: SimplePlaylist[];
}

interface RawSearchResponse {
  tracks?: Page<Track | null>;
  artists?: Page<SimpleArtist | null>;
  albums?: Page<SimpleAlbum | null>;
  playlists?: Page<SimplePlaylist | null>;
}

/**
 * Per-type result counts.
 *
 * Spotify caps `limit` at 10 per type — `limit=20` is a hard 400 `Invalid limit`, not a silent
 * clamp. Totals for a typical query are in the low tens, so there is nothing to paginate.
 */
export const PER_TYPE = { tracks: 6, artists: 4, albums: 4, playlists: 4 } as const;
const MAX_LIMIT = 10;

/** Spotify returns `null` entries inside these arrays; drop them before anything touches a field. */
function compact<T>(page: Page<T | null> | undefined): T[] {
  return (page?.items ?? []).filter((item): item is T => item !== null && item !== undefined);
}

export const EMPTY_RESULTS: SearchResults = {
  tracks: [],
  artists: [],
  albums: [],
  playlists: [],
};

export async function search(
  client: SpotifyClient,
  query: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<SearchResults> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return EMPTY_RESULTS;

  const raw = await client.request<RawSearchResponse>("/search", {
    query: {
      q: trimmed,
      type: "track,artist,album,playlist",
      limit: Math.min(MAX_LIMIT, Math.max(...Object.values(PER_TYPE))),
      market: options.market,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (raw === null) return EMPTY_RESULTS;
  return {
    tracks: compact(raw.tracks).slice(0, PER_TYPE.tracks),
    artists: compact(raw.artists).slice(0, PER_TYPE.artists),
    albums: compact(raw.albums).slice(0, PER_TYPE.albums),
    playlists: compact(raw.playlists).slice(0, PER_TYPE.playlists),
  };
}
