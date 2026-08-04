import {
  albumTracks,
  artistAlbums,
  audiobookChapters,
  audiobookDetails,
  showDetails,
  showEpisodes,
} from "../../api/catalog.ts";
import { fetchLyrics } from "../../api/lyrics.ts";
import { playlistItems } from "../../api/playlists.ts";
import { search, type SearchType } from "../../api/search.ts";
import {
  artistLine,
  isTrack,
  type FullArtist,
  type PlayableItem,
  type SimpleAlbum,
  type SimpleArtist,
  type Track,
} from "../../api/types.ts";
import { tryRuntimeRequest } from "../../runtime/control.ts";
import { unavailable, usageError } from "../errors.ts";
import {
  formatDuration,
  normalizeArtist,
  normalizeAudiobook,
  normalizeEpisode,
  normalizeItem,
  normalizeShow,
} from "../output.ts";
import { cliSession } from "../session.ts";
import {
  normalizePlaylistDetails,
  openablePlaylistDetails,
  playlistHeader,
  table,
} from "../support.ts";
import { spotifyReference } from "../values.ts";
import type { OperationResult } from "./types.ts";

/** `search --type all` covers the four music types; spoken-word types are requested by name. */
export const DEFAULT_SEARCH_TYPES: readonly SearchType[] = [
  "track",
  "artist",
  "album",
  "playlist",
];
export const SEARCH_LIMIT_MAX = 50;

export async function searchCatalog(
  query: string,
  options: { types?: readonly SearchType[]; limit?: number } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  if (options.limit !== undefined && options.limit > SEARCH_LIMIT_MAX) {
    throw usageError(`Search limit cannot exceed ${SEARCH_LIMIT_MAX}.`);
  }
  const types = options.types ?? DEFAULT_SEARCH_TYPES;
  const { client } = await cliSession();
  const results = await search(client, query, {
    types,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const data = {
    tracks: results.tracks.map(normalizeItem),
    artists: results.artists,
    albums: results.albums,
    playlists: results.playlists,
    shows: results.shows.map(normalizeShow),
    episodes: results.episodes.map(normalizeEpisode),
    audiobooks: results.audiobooks.map(normalizeAudiobook),
  };
  const sections: string[] = [];
  if (results.tracks.length > 0)
    sections.push(
      `Tracks\n${table(
        ["TITLE", "ARTIST", "URI"],
        results.tracks.map((item) => [item.name, artistLine(item), item.uri]),
      )}`,
    );
  if (results.artists.length > 0)
    sections.push(
      `Artists\n${table(
        ["NAME", "URI"],
        results.artists.map((item) => [item.name, item.uri]),
      )}`,
    );
  if (results.albums.length > 0)
    sections.push(
      `Albums\n${table(
        ["NAME", "YEAR", "URI"],
        results.albums.map((item) => [
          item.name,
          item.release_date ?? "",
          item.uri,
        ]),
      )}`,
    );
  if (results.playlists.length > 0)
    sections.push(
      `Playlists\n${table(
        ["NAME", "OWNER", "URI"],
        results.playlists.map((item) => [
          item.name,
          item.owner?.display_name ?? "",
          item.uri,
        ]),
      )}`,
    );
  if (results.shows.length > 0)
    sections.push(
      `Shows\n${table(
        ["NAME", "PUBLISHER", "URI"],
        results.shows.map((item) => [item.name, item.publisher ?? "", item.uri]),
      )}`,
    );
  if (results.episodes.length > 0)
    sections.push(
      `Episodes\n${table(
        ["TITLE", "DATE", "TIME", "URI"],
        results.episodes.map((item) => [
          item.name,
          item.release_date ?? "",
          formatDuration(item.duration_ms),
          item.uri,
        ]),
      )}`,
    );
  if (results.audiobooks.length > 0)
    sections.push(
      `Audiobooks\n${table(
        ["NAME", "AUTHOR", "URI"],
        results.audiobooks.map((item) => [
          item.name,
          (item.authors ?? []).map((author) => author.name).join(", "),
          item.uri,
        ]),
      )}`,
    );
  return {
    data,
    message: sections.length === 0 ? "No results." : sections.join("\n\n"),
  };
}

export async function resourceDetails(
  target: string,
): Promise<OperationResult<unknown>> {
  const ref = spotifyReference(target);
  const { client } = await cliSession();
  switch (ref.kind) {
    case "track":
    case "episode": {
      const item = await client.get<PlayableItem>(`/${ref.kind}s/${ref.id}`);
      return {
        data: normalizeItem(item),
        message: `${item.name} — ${artistLine(item)}\n${formatDuration(item.duration_ms)} · ${item.uri}`,
      };
    }
    case "album": {
      const [album, tracks] = await Promise.all([
        client.get<SimpleAlbum & { artists?: SimpleArtist[] }>(
          `/albums/${ref.id}`,
        ),
        albumTracks(client, ref.id),
      ]);
      return {
        data: { ...album, tracks },
        message: `${album.name}${album.release_date ? ` (${album.release_date})` : ""}\n\n${table(
          ["#", "TITLE", "ARTIST", "TIME", "URI"],
          tracks.map((item) => [
            item.track_number,
            item.name,
            item.artists.map((artist) => artist.name).join(", "),
            formatDuration(item.duration_ms),
            item.uri,
          ]),
        )}`,
      };
    }
    case "artist": {
      const [artist, albums] = await Promise.all([
        client.get<FullArtist>(`/artists/${ref.id}`),
        artistAlbums(client, ref.id),
      ]);
      return {
        data: { ...artist, albums },
        message: `${artist.name}\n\n${table(
          ["RELEASE", "DATE", "TRACKS", "URI"],
          albums.map((album) => [
            album.name,
            album.release_date ?? "",
            album.total_tracks ?? "",
            album.uri,
          ]),
        )}`,
      };
    }
    case "playlist": {
      // Ownership first: the items read is permanently refused for foreign playlists, so it
      // must not be spent before the metadata proves it can succeed.
      const details = await openablePlaylistDetails(ref.id);
      const entries = await playlistItems(client, ref.id);
      return {
        data: {
          playlist: normalizePlaylistDetails(details),
          items: entries.map((entry) => ({
            position: entry.position,
            isLocal: entry.isLocal,
            item: normalizeItem(entry.item),
          })),
        },
        message: `${playlistHeader(details)}\n\n${table(
          ["#", "TITLE", "ARTIST", "TIME", "URI"],
          entries.map((entry) => [
            entry.position + 1,
            entry.item.name,
            artistLine(entry.item),
            formatDuration(entry.item.duration_ms),
            entry.item.uri,
          ]),
        )}`,
      };
    }
    case "show": {
      const [show, episodes] = await Promise.all([
        showDetails(client, ref.id),
        showEpisodes(client, ref.id),
      ]);
      return {
        data: {
          ...normalizeShow(show),
          episodes: episodes.map(normalizeEpisode),
        },
        message: `${show.name}${show.publisher ? ` — ${show.publisher}` : ""}\n${show.uri}\n\nLatest episodes\n${table(
          ["TITLE", "DATE", "TIME", "URI"],
          episodes.map((episode) => [
            episode.name,
            episode.release_date ?? "",
            formatDuration(episode.duration_ms),
            episode.uri,
          ]),
        )}`,
      };
    }
    case "audiobook": {
      const [audiobook, chapters] = await Promise.all([
        audiobookDetails(client, ref.id),
        audiobookChapters(client, ref.id),
      ]);
      const authors = (audiobook.authors ?? [])
        .map((author) => author.name)
        .join(", ");
      return {
        data: { ...normalizeAudiobook(audiobook), chapters },
        message: `${audiobook.name}${authors === "" ? "" : ` — ${authors}`}\n${audiobook.uri}\n\nChapters\n${table(
          ["#", "TITLE", "TIME", "URI"],
          // Positional numbering: Spotify's chapter_number is zero-based and the page arrives in
          // reading order anyway.
          chapters.map((chapter, index) => [
            index + 1,
            chapter.name,
            formatDuration(chapter.duration_ms),
            chapter.uri,
          ]),
        )}`,
      };
    }
    default:
      throw usageError(
        `Spotify ${ref.kind} resources are not supported by show.`,
      );
  }
}

/**
 * Narrow a runtime status snapshot to the current track for lyric lookup.
 *
 * The runtime's item uses the same normalized shape the CLI emits, so it doubles as the emitted
 * `track` record without another Web API read.
 */
export function runtimeLyricsTrack(value: unknown): {
  name: string;
  artists: string[];
  artist: string;
  durationMs: number;
  record: Record<string, unknown>;
} {
  const state =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const raw = state["item"];
  if (raw === null || raw === undefined || typeof raw !== "object")
    throw unavailable("The current item is not a track.");
  const item = raw as Record<string, unknown>;
  const name = item["name"];
  const durationMs = item["durationMs"];
  if (
    item["type"] !== "track" ||
    typeof name !== "string" ||
    typeof durationMs !== "number"
  ) {
    throw unavailable("The current item is not a track.");
  }
  const artists = Array.isArray(item["artists"])
    ? item["artists"].filter(
        (artist): artist is string => typeof artist === "string",
      )
    : [];
  return {
    name,
    artists,
    artist:
      typeof item["artist"] === "string" ? item["artist"] : artists.join(", "),
    durationMs,
    record: item,
  };
}

export async function lyricsFor(
  target?: string,
): Promise<OperationResult<Record<string, unknown>>> {
  let subject: {
    name: string;
    artists: string[];
    artist: string;
    durationMs: number;
    record: Record<string, unknown> | null;
  };
  if (target !== undefined) {
    const ref = spotifyReference(target, "track");
    const track = await (await cliSession()).client.get<Track>(
      `/tracks/${ref.id}`,
    );
    subject = {
      name: track.name,
      artists: track.artists.map((artist) => artist.name),
      artist: artistLine(track),
      durationMs: track.duration_ms,
      record: normalizeItem(track),
    };
  } else {
    // While the local receiver is playing, native events outrun `/me/player`; asking the Web
    // API here can return the previous track across a change. The runtime item is
    // authoritative and already carries everything lyric lookup needs.
    const runtime = await tryRuntimeRequest("status");
    if (runtime.connected) {
      subject = runtimeLyricsTrack(runtime.value);
    } else {
      const item = (await (await cliSession()).player.state("foreground"))
        ?.item;
      if (item === null || item === undefined || !isTrack(item))
        throw unavailable("The current item is not a track.");
      subject = {
        name: item.name,
        artists: item.artists.map((artist) => artist.name),
        artist: artistLine(item),
        durationMs: item.duration_ms,
        record: normalizeItem(item),
      };
    }
  }
  const lyrics = await fetchLyrics({
    name: subject.name,
    artists: subject.artists,
    durationMs: subject.durationMs,
  });
  return {
    data: { track: subject.record, lyrics },
    message: `${subject.name} — ${subject.artist}\n${lyrics.source}${lyrics.synced ? " · synced" : ""}\n\n${lyrics.lines.map((line) => line.text).join("\n")}`,
  };
}
