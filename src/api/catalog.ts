import type { SpotifyClient } from "./client.ts";
import type { Page, SimpleAlbum, SimpleArtist } from "./types.ts";

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
