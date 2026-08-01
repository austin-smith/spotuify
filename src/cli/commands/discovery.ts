import { Command, Option } from "commander";
import { albumTracks, artistAlbums } from "../../api/catalog.ts";
import { fetchLyrics } from "../../api/lyrics.ts";
import { playlistItems } from "../../api/playlists.ts";
import { search } from "../../api/search.ts";
import {
  artistLine,
  isTrack,
  type Page,
  type PlayableItem,
  type SimpleAlbum,
  type SimpleArtist,
  type Track,
} from "../../api/types.ts";
import { unavailable, usageError } from "../errors.ts";
import { formatDuration, normalizeItem, type CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { integer, spotifyReference } from "../values.ts";
import { outputFor, table } from "../support.ts";

export function registerDiscovery(program: Command, io: CliIo): void {
  program
    .command("search <query...>")
    .description("Search tracks, artists, albums, and playlists")
    .addOption(
      new Option("-t, --type <type>", "limit output to one resource type")
        .choices(["all", "track", "artist", "album", "playlist"])
        .default("all"),
    )
    .action(
      async (words: string[], options: { type: string }, command: Command) => {
        const { client } = await cliSession();
        const results = await search(client, words.join(" "));
        const data = {
          tracks:
            options.type === "all" || options.type === "track"
              ? results.tracks.map(normalizeItem)
              : [],
          artists:
            options.type === "all" || options.type === "artist"
              ? results.artists
              : [],
          albums:
            options.type === "all" || options.type === "album"
              ? results.albums
              : [],
          playlists:
            options.type === "all" || options.type === "playlist"
              ? results.playlists
              : [],
        };
        const sections: string[] = [];
        if (data.tracks.length > 0)
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
        if (data.artists.length > 0)
          sections.push(
            `Artists\n${table(
              ["NAME", "URI"],
              data.artists.map((item) => [item.name, item.uri]),
            )}`,
          );
        if (data.albums.length > 0)
          sections.push(
            `Albums\n${table(
              ["NAME", "YEAR", "URI"],
              data.albums.map((item) => [
                item.name,
                item.release_date ?? "",
                item.uri,
              ]),
            )}`,
          );
        if (data.playlists.length > 0)
          sections.push(
            `Playlists\n${table(
              ["NAME", "OWNER", "URI"],
              data.playlists.map((item) => [
                item.name,
                item.owner?.display_name ?? "",
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
            client.get<SimpleArtist>(`/artists/${ref.id}`),
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
          const entries = await playlistItems(client, ref.id);
          data = {
            playlist: { id: ref.id, uri: ref.uri },
            items: entries.map((entry) => ({
              position: entry.position,
              isLocal: entry.isLocal,
              item: normalizeItem(entry.track),
            })),
          };
          human = `${ref.uri}\n\n${table(
            ["#", "TITLE", "ARTIST", "TIME", "URI"],
            entries.map((entry) => [
              entry.position + 1,
              entry.track.name,
              artistLine(entry.track),
              formatDuration(entry.track.duration_ms),
              entry.track.uri,
            ]),
          )}`;
          break;
        }
        case "show":
        case "audiobook": {
          const plural = ref.kind === "show" ? "shows" : "audiobooks";
          const resource = await client.get<Record<string, unknown>>(
            `/${plural}/${ref.id}`,
          );
          data = resource;
          human = `${String(resource["name"] ?? ref.uri)}\n${ref.uri}`;
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
      const { client, player } = await cliSession();
      let track: Track;
      if (target !== undefined) {
        const ref = spotifyReference(target, "track");
        track = await client.get<Track>(`/tracks/${ref.id}`);
      } else {
        const item = (await player.state("foreground"))?.item;
        if (item === null || item === undefined || !isTrack(item))
          throw unavailable("The current item is not a track.");
        track = item;
      }
      const lyrics = await fetchLyrics({
        name: track.name,
        artists: track.artists.map((artist) => artist.name),
        durationMs: track.duration_ms,
      });
      outputFor(command, io).emit(
        "lyrics",
        { track: normalizeItem(track), lyrics },
        `${track.name} — ${artistLine(track)}\n${lyrics.source}${lyrics.synced ? " · synced" : ""}\n\n${lyrics.lines.map((line) => line.text).join("\n")}`,
      );
    });

  const history = program
    .command("history")
    .description("Show recent and top listening history");
  history
    .command("recent")
    .description("Show recently played tracks")
    .option("-n, --limit <number>", "number of tracks", "20")
    .action(async (options: { limit: string }, command: Command) => {
      const limit = integer(options.limit, "limit", 1);
      if (limit > 50)
        throw usageError("Recent history limit cannot exceed 50.");
      const { client } = await cliSession();
      const page = await client.get<Page<{ track: Track | null }>>(
        "/me/player/recently-played",
        { limit },
      );
      const tracks = page.items
        .map((item) => item.track)
        .filter((item): item is Track => item !== null);
      outputFor(command, io).emit(
        "history.recent",
        tracks.map(normalizeItem),
        table(
          ["#", "TITLE", "ARTIST", "URI"],
          tracks.map((item, index) => [
            index + 1,
            item.name,
            artistLine(item),
            item.uri,
          ]),
        ),
      );
    });
  history
    .command("top")
    .description("Show the user's top tracks")
    .option("-n, --limit <number>", "number of tracks", "20")
    .addOption(
      new Option("--range <range>", "listening period")
        .choices(["short", "medium", "long"])
        .default("medium"),
    )
    .action(
      async (options: { limit: string; range: string }, command: Command) => {
        const limit = integer(options.limit, "limit", 1);
        if (limit > 50) throw usageError("Top tracks limit cannot exceed 50.");
        const { client } = await cliSession();
        const page = await client.get<Page<Track | null>>("/me/top/tracks", {
          limit,
          time_range: `${options.range}_term`,
        });
        const tracks = page.items.filter(
          (item): item is Track => item !== null,
        );
        outputFor(command, io).emit(
          "history.top",
          tracks.map(normalizeItem),
          table(
            ["#", "TITLE", "ARTIST", "URI"],
            tracks.map((item, index) => [
              index + 1,
              item.name,
              artistLine(item),
              item.uri,
            ]),
          ),
        );
      },
    );
}
