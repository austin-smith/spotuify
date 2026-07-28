import type { SpotifyClient } from "./client.ts";
import type { Page, Track } from "./types.ts";

export interface HomeData {
  recent: Track[];
  top: Track[];
}

export const EMPTY_HOME: HomeData = { recent: [], top: [] };

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
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<HomeData> {
  const query = { limit: PER_GROUP, market: options.market };
  const opts = options.signal ? { signal: options.signal } : {};

  const [recent, top] = await Promise.allSettled([
    client.request<Page<{ track: Track | null }>>("/me/player/recently-played", {
      query: { limit: PER_GROUP * 3 },
      ...opts,
    }),
    client.request<Page<Track | null>>("/me/top/tracks", { query, ...opts }),
  ]);

  return {
    recent:
      recent.status === "fulfilled"
        ? dedupe(compact(recent.value?.items?.map((i) => i.track))).slice(0, PER_GROUP)
        : [],
    top: top.status === "fulfilled" ? compact(top.value?.items) : [],
  };
}
