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

/**
 * A track as returned inside an album.
 *
 * Deliberately not `Track`: the album-tracks endpoint returns a *simplified* object with no `album`
 * field, so the parent album has to be supplied by the caller to build a playable row.
 */
export interface AlbumTrack {
  id: string | null;
  name: string;
  uri: string;
  duration_ms: number;
  track_number: number;
  disc_number?: number;
  artists: SimpleArtist[];
}

/** `/artists/{id}/albums` rejects any limit above 10 with a 400. */
const ARTIST_ALBUMS_LIMIT = 10;
/** `/albums/{id}/tracks` accepts up to 50, which covers essentially every album in one request. */
const ALBUM_TRACKS_LIMIT = 50;

function compact<T>(page: Page<T | null> | null): T[] {
  return (page?.items ?? []).filter((item): item is T => item !== null && item !== undefined);
}

/**
 * An artist's releases, newest first.
 *
 * Restricted to albums and singles: the default also returns `appears_on`, which floods the list
 * with compilations the artist merely features on. Live albums and expanded editions still come
 * through — the year and track count on each row are what tell them apart.
 */
export async function artistAlbums(
  client: SpotifyClient,
  artistId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<SimpleAlbum[]> {
  const page = await client.request<Page<SimpleAlbum | null>>(`/artists/${artistId}/albums`, {
    query: {
      limit: ARTIST_ALBUMS_LIMIT,
      include_groups: "album,single",
      market: options.market,
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return compact(page).sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
}

// There is deliberately no top-tracks function: `/artists/{id}/top-tracks` answers 403 for every
// request, like the retired playlist `/tracks` route. An artist's catalog here is their releases.

/** An album's track list, in running order. */
export async function albumTracks(
  client: SpotifyClient,
  albumId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<AlbumTrack[]> {
  const page = await client.request<Page<AlbumTrack | null>>(`/albums/${albumId}/tracks`, {
    query: { limit: ALBUM_TRACKS_LIMIT, market: options.market },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return compact(page);
}

/** A chapter as returned inside an audiobook: simplified, with no parent audiobook field. */
export interface AudiobookChapter {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  chapter_number: number;
}

/** Both listing endpoints accept up to 50 per page. */
const SHOW_EPISODES_LIMIT = 50;

export async function showDetails(
  client: SpotifyClient,
  showId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<SimpleShow> {
  const show = await client.request<SimpleShow | null>(`/shows/${showId}`, {
    query: { market: options.market },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (show === null) throw new Error("spotify returned no show");
  return show;
}

/**
 * A show's most recent episodes, newest first — the order Spotify returns.
 *
 * Deliberately one page. A daily show carries thousands of episodes, and a listing that walks all
 * of them punishes exactly the shows people follow most; the episode URI needed to play or queue
 * one is almost always in the latest fifty.
 */
export async function showEpisodes(
  client: SpotifyClient,
  showId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<Episode[]> {
  const page = await client.request<Page<Episode | null>>(`/shows/${showId}/episodes`, {
    query: { limit: SHOW_EPISODES_LIMIT, market: options.market },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return compact(page);
}

export async function audiobookDetails(
  client: SpotifyClient,
  audiobookId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<SimpleAudiobook> {
  const audiobook = await client.request<SimpleAudiobook | null>(`/audiobooks/${audiobookId}`, {
    query: { market: options.market },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (audiobook === null) throw new Error("spotify returned no audiobook");
  return audiobook;
}

/** An audiobook's chapters, in reading order. One page covers nearly every audiobook. */
export async function audiobookChapters(
  client: SpotifyClient,
  audiobookId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<AudiobookChapter[]> {
  const page = await client.request<Page<AudiobookChapter | null>>(
    `/audiobooks/${audiobookId}/chapters`,
    {
      query: { limit: SHOW_EPISODES_LIMIT, market: options.market },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return compact(page);
}
