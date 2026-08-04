import {
  addPlaylistItems,
  myPlaylists,
  type Playlist,
} from "../../api/playlists.ts";
import { usageError } from "../errors.ts";
import { cliSession } from "../session.ts";
import { playlistId, table } from "../support.ts";
import { spotifyReference } from "../values.ts";
import type { OperationResult } from "./types.ts";

export async function playlistList(
  options: { ownedOnly?: boolean } = {},
): Promise<OperationResult<Playlist[]>> {
  const session = await cliSession();
  const me = await session.profile();
  const all = (await myPlaylists(session.client, me.id)).filter(
    (item) => options.ownedOnly !== true || item.mine,
  );
  return {
    data: all,
    message: table(
      ["OWNED", "NAME", "OWNER", "URI"],
      all.map((item) => [
        item.mine ? "yes" : "no",
        item.name,
        item.ownerName,
        item.uri,
      ]),
    ),
  };
}

export async function playlistAdd(
  playlist: string,
  items: string[],
): Promise<OperationResult<Record<string, unknown>>> {
  const uris = items.map((item) => {
    const ref = spotifyReference(item);
    if (ref.kind !== "track" && ref.kind !== "episode")
      throw usageError("Playlists accept tracks and episodes only.");
    return ref.uri;
  });
  const snapshotId = await addPlaylistItems(
    (await cliSession()).client,
    playlistId(playlist),
    uris,
  );
  return {
    data: {
      playlist: spotifyReference(playlist, "playlist").uri,
      uris,
      snapshotId,
    },
    message: `Added ${uris.length} item${uris.length === 1 ? "" : "s"}.`,
  };
}
