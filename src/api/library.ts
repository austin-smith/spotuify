import { SpotifyLimitError, type SpotifyClient } from "./client.ts";
import { myPlaylists, type Playlist } from "./playlists.ts";
import type { Page, Track } from "./types.ts";

export interface HomeData {
  recent: Track[];
  top: Track[];
  /** Every playlist the user has, not just the ones shown — the palette matches names against it. */
  playlists: Playlist[];
}

export const EMPTY_HOME: HomeData = { recent: [], top: [], playlists: [] };

/** Rows per group before typing. */
const PER_GROUP = 5;

function compact<T>(items: (T | null | undefined)[] | undefined): T[] {
  return (items ?? []).filter((item): item is T => item !== null && item !== undefined);
}

/** Keep the first occurrence of each track; recently-played repeats the same track often. */
function dedupe(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = track.id ?? track.uri;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What the palette shows before anything is typed.
 *
 * Every request is independent and failures are swallowed per group: some of these endpoints are
 * restricted depending on the app and account, and one 403 should cost that section rather than the
 * whole screen.
 */
export async function fetchHome(
  client: SpotifyClient,
  options: { market?: string; meId?: string; signal?: AbortSignal } = {},
): Promise<HomeData> {
  const query = { limit: PER_GROUP, market: options.market };
  const opts = {
    priority: "background" as const,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const [recent, top, playlists] = await Promise.allSettled([
    client.request<Page<{ track: Track | null }>>("/me/player/recently-played", {
      query: { limit: PER_GROUP * 3 },
      ...opts,
    }),
    client.request<Page<Track | null>>("/me/top/tracks", { query, ...opts }),
    // Without an id nothing can be marked as the user's own, and an unopenable playlist list is
    // worse than none — so skip the request entirely rather than show rows that all refuse to open.
    options.meId === undefined
      ? Promise.resolve([])
      : myPlaylists(client, options.meId, opts),
  ]);

  // Endpoint-specific restrictions only cost their own section, but a 429 opens the client's
  // shared circuit and makes the whole batch incomplete. Preserve that typed failure so callers
  // do not cache an empty/partial home as if it were a successful library snapshot.
  for (const result of [recent, top, playlists]) {
    if (result.status === "rejected" && result.reason instanceof SpotifyLimitError) {
      throw result.reason;
    }
  }

  return {
    recent:
      recent.status === "fulfilled"
        ? dedupe(compact(recent.value?.items?.map((i) => i.track))).slice(0, PER_GROUP)
        : [],
    top: top.status === "fulfilled" ? compact(top.value?.items) : [],
    playlists: playlists.status === "fulfilled" ? playlists.value : [],
  };
}
