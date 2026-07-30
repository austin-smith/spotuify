import { SpotifyApiError, type SpotifyClient } from "./client.ts";
import type { Track } from "./types.ts";

/**
 * A playlist as the palette needs it.
 *
 * `mine` is not cosmetic: Spotify answers `/playlists/{id}/items` with a 403 for every playlist the
 * signed-in user does not own, including public ones they follow, so it decides whether a row can be
 * opened at all.
 */
export interface Playlist {
  id: string;
  name: string;
  uri: string;
  ownerId: string;
  ownerName: string;
  mine: boolean;
}

/**
 * One line of a playlist, with its true position.
 *
 * `position` is the index within the playlist rather than within this array. Playing a row starts
 * the playlist as a context at an offset, so an entry dropped for being unreadable must not shift
 * everything after it — that would start the wrong track.
 */
export interface PlaylistEntry {
  position: number;
  track: Track;
  isLocal: boolean;
}

interface RawEntry {
  is_local?: boolean;
  /**
   * The item itself.
   *
   * `item` is the current key. The older `track` is deprecated and, as of this writing, absent from
   * the responses entirely, so it is only read as a fallback.
   */
  item?: (Track & { type?: string }) | null;
  track?: (Track & { type?: string }) | null;
}

interface RawPlaylist {
  id: string;
  name: string;
  uri: string;
  owner?: { id?: string; display_name?: string | null };
}

/** `/me/playlists` accepts at most 50 per page. */
const PLAYLIST_PAGE = 50;

/** `/playlists/{id}/items` accepts at most 50 per the public endpoint contract. */
const ITEM_PAGE = 50;

/**
 * Only the fields the rows actually read.
 *
 * Measured on a 101-track playlist: 104,733 bytes unfiltered against 37,009 filtered, for the same
 * rows on screen.
 */
const ITEM_FIELDS =
  "next,items(is_local,item(id,name,uri,duration_ms,type,artists(id,name,uri),album(id,name,uri,images)))";

const PLAYLIST_FIELDS = "next,items(id,name,uri,owner(id,display_name))";

interface RawPage<T> {
  items?: (T | null)[] | null;
  next?: string | null;
}

function toPlaylist(raw: RawPlaylist, meId: string): Playlist {
  const ownerId = raw.owner?.id ?? "";
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    ownerId,
    ownerName: raw.owner?.display_name ?? ownerId,
    mine: ownerId !== "" && ownerId === meId,
  };
}

/**
 * The signed-in user's playlists, in whatever order Spotify returns them.
 *
 * Deliberately not sorted. Spotify does not document an order for this endpoint and returns no date
 * to sort by, so imposing one would mean inventing it — and the order it does return is the one the
 * user sees in every other Spotify client.
 *
 * Includes playlists they merely follow. Those cannot be opened — see `Playlist.mine` — but they are
 * still theirs to play, and hiding them would make the list disagree with every other Spotify
 * client.
 */
export async function myPlaylists(
  client: SpotifyClient,
  meId: string,
  options: { signal?: AbortSignal; priority?: "foreground" | "background" } = {},
): Promise<Playlist[]> {
  const opts = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.priority ? { priority: options.priority } : {}),
  };
  const playlists: Playlist[] = [];

  for (let offset = 0; ; offset += PLAYLIST_PAGE) {
    const page = await client.request<RawPage<RawPlaylist>>("/me/playlists", {
      query: { limit: PLAYLIST_PAGE, offset, fields: PLAYLIST_FIELDS },
      ...opts,
    });

    for (const raw of page?.items ?? []) {
      if (raw !== null && raw !== undefined) playlists.push(toPlaylist(raw, meId));
    }
    if (page?.next === null || page?.next === undefined) break;
  }

  return playlists;
}

/**
 * A playlist's contents.
 *
 * Uses `/items`, not `/tracks`. As of this writing `/playlists/{id}/tracks` returns 403 for every
 * playlist — including ones the user owns — so the endpoint every tutorial still recommends is
 * simply gone.
 */
export async function playlistItems(
  client: SpotifyClient,
  playlistId: string,
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<PlaylistEntry[]> {
  const opts = options.signal ? { signal: options.signal } : {};
  const entries: PlaylistEntry[] = [];

  try {
    for (let offset = 0; ; offset += ITEM_PAGE) {
      const page = await client.request<RawPage<RawEntry>>(`/playlists/${playlistId}/items`, {
        query: { limit: ITEM_PAGE, offset, market: options.market, fields: ITEM_FIELDS },
        ...opts,
      });

      const items = page?.items ?? [];
      items.forEach((raw, index) => {
        const track = raw?.item ?? raw?.track ?? null;
        // Episodes carry no artists or album, and the rows are built for tracks. Skipping them
        // still costs a position, which is exactly why `position` is tracked rather than inferred.
        if (track === null || track.type === "episode") return;
        if (typeof track.name !== "string" || typeof track.uri !== "string") return;
        entries.push({
          position: offset + index,
          track,
          isLocal: raw?.is_local === true,
        });
      });

      if (page?.next === null || page?.next === undefined) break;
    }
  } catch (err) {
    throw describePlaylistFailure(err);
  }

  return entries;
}

/**
 * Turn Spotify's refusals into something the palette can print.
 *
 * The raw message is "Spotify API 403 on /playlists/x/items: Forbidden", which names an endpoint the
 * user never asked about and does not say the one thing that matters: this only works on playlists
 * you own.
 */
function describePlaylistFailure(err: unknown): Error {
  if (err instanceof SpotifyApiError) {
    if (err.status === 403) return new Error("spotify only opens playlists you own");
    if (err.status === 404) return new Error("spotify no longer exposes this playlist");
  }
  return err instanceof Error ? err : new Error(String(err));
}
