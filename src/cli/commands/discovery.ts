import { Command, Option } from "commander";
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
  type Episode,
  type FullArtist,
  type Page,
  type PlayableItem,
  type SimpleAlbum,
  type SimpleArtist,
  type SimpleAudiobook,
  type SimpleShow,
  type Track,
} from "../../api/types.ts";
import { tryRuntimeRequest } from "../../runtime/control.ts";
import { unavailable, usageError } from "../errors.ts";
import { formatDuration, normalizeItem, type CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { integer, spotifyReference, timestampMs } from "../values.ts";
import {
  normalizePlaylistDetails,
  openablePlaylistDetails,
  outputFor,
  playlistHeader,
  table,
} from "../support.ts";

/** `search --type all` covers the four music types; spoken-word types are requested by name. */
const DEFAULT_SEARCH_TYPES: readonly SearchType[] = ["track", "artist", "album", "playlist"];
const SEARCH_LIMIT_MAX = 50;
const HISTORY_LIMIT_MAX = 50;

function normalizeEpisode(episode: Episode): Record<string, unknown> {
  return normalizeItem(episode) ?? {};
}

function normalizeShow(show: SimpleShow): Record<string, unknown> {
  return {
    type: "show",
    id: show.id,
    uri: show.uri,
    name: show.name,
    publisher: show.publisher ?? null,
    description: show.description ?? null,
    totalEpisodes: show.total_episodes ?? null,
  };
}

function normalizeAudiobook(audiobook: SimpleAudiobook): Record<string, unknown> {
  return {
    type: "audiobook",
    id: audiobook.id,
    uri: audiobook.uri,
    name: audiobook.name,
    authors: (audiobook.authors ?? []).map((author) => author.name),
    publisher: audiobook.publisher ?? null,
    totalChapters: audiobook.total_chapters ?? null,
  };
}

function normalizeArtist(artist: FullArtist): Record<string, unknown> {
  return {
    type: "artist",
    id: artist.id,
    uri: artist.uri,
    name: artist.name,
    genres: artist.genres ?? [],
    followers: artist.followers?.total ?? null,
  };
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
    artist: typeof item["artist"] === "string" ? item["artist"] : artists.join(", "),
    durationMs,
    record: item,
  };
}

export function registerDiscovery(program: Command, io: CliIo): void {
  program
    .command("search <query...>")
    .description("Search the Spotify catalog")
    .addOption(
      new Option("-t, --type <type>", "limit output to one resource type")
        .choices([
          "all",
          "track",
          "artist",
          "album",
          "playlist",
          "show",
          "episode",
          "audiobook",
        ])
        .default("all"),
    )
    .option("-n, --limit <number>", "results per resource type")
    .action(
      async (
        words: string[],
        options: { type: string; limit?: string },
        command: Command,
      ) => {
        const limit =
          options.limit === undefined
            ? undefined
            : integer(options.limit, "limit", 1);
        if (limit !== undefined && limit > SEARCH_LIMIT_MAX) {
          throw usageError(`Search limit cannot exceed ${SEARCH_LIMIT_MAX}.`);
        }
        const types: readonly SearchType[] =
          options.type === "all"
            ? DEFAULT_SEARCH_TYPES
            : [options.type as SearchType];
        const { client } = await cliSession();
        const results = await search(client, words.join(" "), {
          types,
          ...(limit !== undefined ? { limit } : {}),
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
              results.tracks.map((item) => [
                item.name,
                artistLine(item),
                item.uri,
              ]),
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
              results.shows.map((item) => [
                item.name,
                item.publisher ?? "",
                item.uri,
              ]),
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
        outputFor(command, io).emit(
          "search",
          data,
          sections.length === 0 ? "No results." : sections.join("\n\n"),
        );
      },
    );

  program
    .command("show <target>")
    .description("Show a Spotify resource and its playable contents")
    .action(async (target: string, _options, command: Command) => {
      const ref = spotifyReference(target);
      const { client } = await cliSession();
      let data: unknown;
      let human: string;
      switch (ref.kind) {
        case "track":
        case "episode": {
          const item = await client.get<PlayableItem>(
            `/${ref.kind}s/${ref.id}`,
          );
          data = normalizeItem(item);
          human = `${item.name} — ${artistLine(item)}\n${formatDuration(item.duration_ms)} · ${item.uri}`;
          break;
        }
        case "album": {
          const [album, tracks] = await Promise.all([
            client.get<SimpleAlbum & { artists?: SimpleArtist[] }>(
              `/albums/${ref.id}`,
            ),
            albumTracks(client, ref.id),
          ]);
          data = { ...album, tracks };
          human = `${album.name}${album.release_date ? ` (${album.release_date})` : ""}\n\n${table(
            ["#", "TITLE", "ARTIST", "TIME", "URI"],
            tracks.map((item) => [
              item.track_number,
              item.name,
              item.artists.map((artist) => artist.name).join(", "),
              formatDuration(item.duration_ms),
              item.uri,
            ]),
          )}`;
          break;
        }
        case "artist": {
          const [artist, albums] = await Promise.all([
            client.get<FullArtist>(`/artists/${ref.id}`),
            artistAlbums(client, ref.id),
          ]);
          data = { ...artist, albums };
          human = `${artist.name}\n\n${table(
            ["RELEASE", "DATE", "TRACKS", "URI"],
            albums.map((album) => [
              album.name,
              album.release_date ?? "",
              album.total_tracks ?? "",
              album.uri,
            ]),
          )}`;
          break;
        }
        case "playlist": {
          // Ownership first: the items read is permanently refused for foreign playlists, so it
          // must not be spent before the metadata proves it can succeed.
          const details = await openablePlaylistDetails(ref.id);
          const entries = await playlistItems(client, ref.id);
          data = {
            playlist: normalizePlaylistDetails(details),
            items: entries.map((entry) => ({
              position: entry.position,
              isLocal: entry.isLocal,
              item: normalizeItem(entry.item),
            })),
          };
          human = `${playlistHeader(details)}\n\n${table(
            ["#", "TITLE", "ARTIST", "TIME", "URI"],
            entries.map((entry) => [
              entry.position + 1,
              entry.item.name,
              artistLine(entry.item),
              formatDuration(entry.item.duration_ms),
              entry.item.uri,
            ]),
          )}`;
          break;
        }
        case "show": {
          const [show, episodes] = await Promise.all([
            showDetails(client, ref.id),
            showEpisodes(client, ref.id),
          ]);
          data = {
            ...normalizeShow(show),
            episodes: episodes.map(normalizeEpisode),
          };
          human = `${show.name}${show.publisher ? ` — ${show.publisher}` : ""}\n${show.uri}\n\nLatest episodes\n${table(
            ["TITLE", "DATE", "TIME", "URI"],
            episodes.map((episode) => [
              episode.name,
              episode.release_date ?? "",
              formatDuration(episode.duration_ms),
              episode.uri,
            ]),
          )}`;
          break;
        }
        case "audiobook": {
          const [audiobook, chapters] = await Promise.all([
            audiobookDetails(client, ref.id),
            audiobookChapters(client, ref.id),
          ]);
          data = { ...normalizeAudiobook(audiobook), chapters };
          const authors = (audiobook.authors ?? [])
            .map((author) => author.name)
            .join(", ");
          human = `${audiobook.name}${authors === "" ? "" : ` — ${authors}`}\n${audiobook.uri}\n\nChapters\n${table(
            ["#", "TITLE", "TIME", "URI"],
            // Positional numbering: Spotify's chapter_number is zero-based and the page arrives in
            // reading order anyway.
            chapters.map((chapter, index) => [
              index + 1,
              chapter.name,
              formatDuration(chapter.duration_ms),
              chapter.uri,
            ]),
          )}`;
          break;
        }
        default:
          throw usageError(
            `Spotify ${ref.kind} resources are not supported by show.`,
          );
      }
      outputFor(command, io).emit("show", data, human);
    });

  program
    .command("lyrics [track]")
    .description("Show lyrics for a track or the current track")
    .action(async (target: string | undefined, _options, command: Command) => {
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
      outputFor(command, io).emit(
        "lyrics",
        { track: subject.record, lyrics },
        `${subject.name} — ${subject.artist}\n${lyrics.source}${lyrics.synced ? " · synced" : ""}\n\n${lyrics.lines.map((line) => line.text).join("\n")}`,
      );
    });

  const history = program
    .command("history")
    .description("Show recent and top listening history");
  history
    .command("recent")
    .description("Show recently played tracks")
    .option("-n, --limit <number>", "number of tracks", "20")
    .option("--before <time>", "only plays before an ISO 8601 time or epoch ms")
    .option("--after <time>", "only plays after an ISO 8601 time or epoch ms")
    .action(
      async (
        options: { limit: string; before?: string; after?: string },
        command: Command,
      ) => {
        const limit = integer(options.limit, "limit", 1);
        if (limit > HISTORY_LIMIT_MAX)
          throw usageError(`Recent history limit cannot exceed ${HISTORY_LIMIT_MAX}.`);
        if (options.before !== undefined && options.after !== undefined) {
          throw usageError("Choose only one of --before or --after.");
        }
        const { client } = await cliSession();
        const page = await client.get<Page<{ track: Track | null; played_at?: string }>>(
          "/me/player/recently-played",
          {
            limit,
            ...(options.before !== undefined
              ? { before: timestampMs(options.before, "before") }
              : {}),
            ...(options.after !== undefined
              ? { after: timestampMs(options.after, "after") }
              : {}),
          },
        );
        const plays = page.items.filter(
          (item): item is { track: Track; played_at?: string } =>
            item.track !== null,
        );
        outputFor(command, io).emit(
          "history.recent",
          plays.map((play) => ({
            playedAt: play.played_at ?? null,
            ...normalizeItem(play.track),
          })),
          table(
            ["#", "TITLE", "ARTIST", "URI"],
            plays.map((play, index) => [
              index + 1,
              play.track.name,
              artistLine(play.track),
              play.track.uri,
            ]),
          ),
        );
      },
    );
  history
    .command("top")
    .description("Show the user's top tracks or artists")
    .option("-n, --limit <number>", "number of results", "20")
    .addOption(
      new Option("-t, --type <type>", "resource type")
        .choices(["track", "artist"])
        .default("track"),
    )
    .addOption(
      new Option("--range <range>", "listening period")
        .choices(["short", "medium", "long"])
        .default("medium"),
    )
    .option("--offset <number>", "number of results to skip", "0")
    .action(
      async (
        options: { limit: string; type: string; range: string; offset: string },
        command: Command,
      ) => {
        const limit = integer(options.limit, "limit", 1);
        if (limit > HISTORY_LIMIT_MAX)
          throw usageError(`Top ${options.type}s limit cannot exceed ${HISTORY_LIMIT_MAX}.`);
        const offset = integer(options.offset, "offset", 0);
        const query = {
          limit,
          time_range: `${options.range}_term`,
          ...(offset > 0 ? { offset } : {}),
        };
        const { client } = await cliSession();
        if (options.type === "artist") {
          const page = await client.get<Page<FullArtist | null>>(
            "/me/top/artists",
            query,
          );
          const artists = page.items.filter(
            (item): item is FullArtist => item !== null,
          );
          outputFor(command, io).emit(
            "history.top",
            artists.map(normalizeArtist),
            table(
              ["#", "NAME", "GENRES", "URI"],
              artists.map((item, index) => [
                offset + index + 1,
                item.name,
                (item.genres ?? []).slice(0, 3).join(", "),
                item.uri,
              ]),
            ),
          );
          return;
        }
        const page = await client.get<Page<Track | null>>("/me/top/tracks", query);
        const tracks = page.items.filter(
          (item): item is Track => item !== null,
        );
        outputFor(command, io).emit(
          "history.top",
          tracks.map(normalizeItem),
          table(
            ["#", "TITLE", "ARTIST", "URI"],
            tracks.map((item, index) => [
              offset + index + 1,
              item.name,
              artistLine(item),
              item.uri,
            ]),
          ),
        );
      },
    );
}
