import type { SpotifyClient } from "./client.ts";
import type { FullArtist } from "./types.ts";

/**
 * Following an artist or user is library membership.
 *
 * The classic `/me/following` mutation and `/me/following/contains` endpoints answer 403 for every
 * request, exactly like the retired playlist `/tracks` route: follows are written and checked
 * through the current URI-based `/me/library` family (`saveLibraryItems`, `removeLibraryItems`,
 * `libraryContains`) with `spotify:artist:` and `spotify:user:` URIs. Verified against the live
 * API — a followed artist reads back `true` from `/me/library/contains`.
 *
 * Listing is the one follow operation that still lives here: `GET /me/following?type=artist`
 * remains the only way to enumerate followed artists, and no endpoint enumerates followed users.
 */

/** `/me/following` returns at most 50 artists per page. */
const FOLLOW_PAGE_SIZE = 50;

/**
 * Every artist the signed-in user follows.
 *
 * Cursor-paged, unlike the offset paging everywhere else: each page names the artist to continue
 * after.
 */
export async function followedArtists(
  client: SpotifyClient,
  options: { signal?: AbortSignal } = {},
): Promise<FullArtist[]> {
  const artists: FullArtist[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await client.request<{
      artists?: {
        items?: (FullArtist | null)[] | null;
        cursors?: { after?: string | null } | null;
      } | null;
    }>("/me/following", {
      query: { type: "artist", limit: FOLLOW_PAGE_SIZE, after },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const page = response?.artists;
    for (const item of page?.items ?? []) {
      if (item !== null && item !== undefined) artists.push(item);
    }
    const cursor = page?.cursors?.after;
    if (typeof cursor !== "string" || cursor.length === 0) break;
    after = cursor;
  }

  return artists;
}
