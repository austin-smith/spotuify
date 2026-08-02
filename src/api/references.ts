import type { SpotifyClient } from "./client.ts";
import type { SimplePlaylist } from "./search.ts";
import type { SimpleAlbum, SimpleArtist, Track } from "./types.ts";
import type { SpotifyReference } from "../spotify/reference.ts";

export type ResolvedSpotifyReference =
  | { type: "track"; item: Track }
  | { type: "artist"; item: SimpleArtist }
  | { type: "album"; item: SimpleAlbum }
  | { type: "playlist"; item: SimplePlaylist };

export function supportsSpotifyReference(
  reference: SpotifyReference,
): reference is SpotifyReference & { type: ResolvedSpotifyReference["type"] } {
  return ["track", "artist", "album", "playlist"].includes(reference.type);
}

/** Resolve a direct reference into the same typed metadata used by ordinary search results. */
export async function resolveSpotifyReference(
  client: SpotifyClient,
  reference: SpotifyReference & { type: ResolvedSpotifyReference["type"] },
  options: { market?: string; signal?: AbortSignal } = {},
): Promise<ResolvedSpotifyReference> {
  const request = <T>(path: string, marketAware = false) =>
    client.request<T>(path, {
      ...(marketAware ? { query: { market: options.market } } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });

  switch (reference.type) {
    case "track": {
      const item = await request<Track>(`/tracks/${reference.id}`, true);
      if (item === null) throw new Error("spotify returned no track");
      return { type: "track", item };
    }
    case "artist": {
      const item = await request<SimpleArtist>(`/artists/${reference.id}`);
      if (item === null) throw new Error("spotify returned no artist");
      return { type: "artist", item };
    }
    case "album": {
      const item = await request<SimpleAlbum>(`/albums/${reference.id}`, true);
      if (item === null) throw new Error("spotify returned no album");
      return { type: "album", item };
    }
    case "playlist": {
      const item = await request<SimplePlaylist>(`/playlists/${reference.id}`);
      if (item === null) throw new Error("spotify returned no playlist");
      return { type: "playlist", item };
    }
  }
}
