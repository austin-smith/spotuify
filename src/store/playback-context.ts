import type { SpotifyClient } from "../api/client.ts";
import {
  resolveSpotifyReference,
  supportsSpotifyReference,
} from "../api/references.ts";
import { isTrack, type PlayableItem } from "../api/types.ts";
import { parseSpotifyReference } from "../spotify/reference.ts";
import type { Drill } from "./rows.ts";

export class PlaybackContextUnavailableError extends Error {
  constructor(message = "current playback has no browsable context") {
    super(message);
    this.name = "PlaybackContextUnavailableError";
  }
}

/** Resolve the authoritative playback-store context into a palette drill target. */
export async function playbackContextDrill(options: {
  client: SpotifyClient;
  meId: string;
  contextUri: string | null;
  item: PlayableItem | null;
  market?: string;
  signal?: AbortSignal;
}): Promise<Drill> {
  const reference = options.contextUri === null
    ? null
    : parseSpotifyReference(options.contextUri);
  if (reference === null || !supportsSpotifyReference(reference) || reference.type === "track") {
    throw new PlaybackContextUnavailableError();
  }

  // A track already contains the album and artist relationships needed for the usual cases. Reuse
  // them instead of spending another Web API request; unusual contexts still resolve canonically.
  const item = options.item;
  if (item !== null && isTrack(item)) {
    if (
      reference.type === "album" &&
      item.album.uri === reference.uri &&
      item.album.id !== ""
    ) {
      return {
        kind: "album",
        id: item.album.id,
        name: item.album.name,
        uri: item.album.uri,
      };
    }
    if (reference.type === "artist") {
      const artist = item.artists.find((candidate) => candidate.uri === reference.uri);
      if (artist !== undefined && artist.id !== "") {
        return { kind: "artist", id: artist.id, name: artist.name };
      }
    }
  }

  const resolved = await resolveSpotifyReference(options.client, reference, {
    market: options.market,
    signal: options.signal,
  });
  switch (resolved.type) {
    case "track":
      throw new PlaybackContextUnavailableError();
    case "artist":
      return { kind: "artist", id: resolved.item.id, name: resolved.item.name };
    case "album":
      return {
        kind: "album",
        id: resolved.item.id,
        name: resolved.item.name,
        uri: resolved.item.uri,
      };
    case "playlist": {
      if (resolved.item.owner?.id !== options.meId) {
        throw new PlaybackContextUnavailableError(
          "Spotify only allows this app to open playlists you own",
        );
      }
      return {
        kind: "playlist",
        id: resolved.item.id,
        name: resolved.item.name,
        uri: resolved.item.uri,
      };
    }
  }
}
