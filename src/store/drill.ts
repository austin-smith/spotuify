import { albumTracks, artistAlbums } from "../api/catalog.ts";
import type { SpotifyClient } from "../api/client.ts";
import { playlistItems } from "../api/playlists.ts";
import {
  toAlbumRows,
  toArtistRows,
  toPlaylistRows,
  type Drill,
  type Row,
} from "./rows.ts";

/** Load the rows behind a catalog or library drill target. */
export async function rowsForDrill(
  client: SpotifyClient,
  target: Drill,
  options: { market?: string; signal: AbortSignal },
): Promise<Row[]> {
  switch (target.kind) {
    case "artist":
      return toArtistRows(await artistAlbums(client, target.id, options));
    case "album":
      return toAlbumRows(
        { id: target.id, name: target.name, uri: target.uri },
        await albumTracks(client, target.id, options),
      );
    case "playlist":
      return toPlaylistRows(
        { name: target.name, uri: target.uri },
        await playlistItems(client, target.id, options),
      );
  }
}
