import { SpotifyLimitError, type SpotifyClient } from "./client.ts";
import { myPlaylists, type Playlist } from "./playlists.ts";
import type { Page, SimpleAlbum, Track } from "./types.ts";

/** Spotify accepts at most 40 URIs on each current library endpoint. */
const LIBRARY_BATCH_SIZE = 40;

/** Spotify returns at most 50 saved albums per page. */
const SAVED_ALBUM_PAGE_SIZE = 50;

interface SavedAlbumPage {
  items?: ({ album?: SimpleAlbum | null } | null)[] | null;
  next?: string | null;
}

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

/** Every album saved in the signed-in user's library, in Spotify's library order. */
export async function savedAlbums(
  client: SpotifyClient,
  options: {
    market?: string;
    signal?: AbortSignal;
    priority?: "foreground" | "background";
    probeIndefiniteCooldown?: boolean;
  } = {},
): Promise<SimpleAlbum[]> {
  const albums: SimpleAlbum[] = [];

  for (let offset = 0; ; offset += SAVED_ALBUM_PAGE_SIZE) {
    const requestOptions = {
      query: {
        limit: SAVED_ALBUM_PAGE_SIZE,
        offset,
        market: options.market,
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.priority ? { priority: options.priority } : {}),
    };
    const page = options.probeIndefiniteCooldown === true && offset === 0
      ? await client.retryAfterIndefiniteCooldown<SavedAlbumPage>("/me/albums", requestOptions)
      : await client.request<SavedAlbumPage>("/me/albums", requestOptions);

    for (const saved of page?.items ?? []) {
      if (saved?.album !== null && saved?.album !== undefined) albums.push(saved.album);
    }
    if (page?.next === null || page?.next === undefined) break;
  }

  return albums;
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

function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

/**
 * Check whether Spotify URIs are in the signed-in user's library.
 *
 * Uses the current URI-based endpoint rather than the deprecated, type-specific `/me/tracks`
 * family. The response is validated at the API boundary so a malformed or partial boolean array
 * can never be mistaken for "not saved".
 */
export async function libraryContains(
  client: SpotifyClient,
  uris: readonly string[],
): Promise<boolean[]> {
  const result: boolean[] = [];

  for (const batch of batches(uris, LIBRARY_BATCH_SIZE)) {
    const response = await client.get<unknown>("/me/library/contains", {
      uris: batch.join(","),
    });
    if (
      !Array.isArray(response) ||
      response.length !== batch.length ||
      response.some((value) => typeof value !== "boolean")
    ) {
      throw new Error("spotify returned an invalid library membership response");
    }
    result.push(...response);
  }

  return result;
}

async function mutateLibrary(
  client: SpotifyClient,
  method: "PUT" | "DELETE",
  uris: readonly string[],
): Promise<void> {
  for (const batch of batches(uris, LIBRARY_BATCH_SIZE)) {
    await client.request("/me/library", {
      method,
      query: { uris: batch.join(",") },
    });
  }
}

/** Save one or more Spotify URIs to the signed-in user's library. */
export async function saveLibraryItems(
  client: SpotifyClient,
  uris: readonly string[],
): Promise<void> {
  await mutateLibrary(client, "PUT", uris);
}

/** Remove one or more Spotify URIs from the signed-in user's library. */
export async function removeLibraryItems(
  client: SpotifyClient,
  uris: readonly string[],
): Promise<void> {
  await mutateLibrary(client, "DELETE", uris);
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
  options: {
    market?: string;
    meId?: string;
    signal?: AbortSignal;
    /**
     * Optional shared playlist catalog.
     *
     * Search and the add-to-playlist picker both need `/me/playlists`. Supplying the session
     * catalog here prevents those features from independently paging through the same collection.
     */
    loadPlaylists?: () => Promise<Playlist[]>;
  } = {},
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
      : options.loadPlaylists?.() ?? myPlaylists(client, options.meId, opts),
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
