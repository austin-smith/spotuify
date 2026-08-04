import { Command, Option } from "commander";
import type { SearchType } from "../../api/search.ts";
import {
  artistLine,
  type FullArtist,
  type Page,
  type Track,
} from "../../api/types.ts";
import { usageError } from "../errors.ts";
import {
  normalizeArtist,
  normalizeItem,
  type CliIo,
} from "../output.ts";
import { lyricsFor, resourceDetails, searchCatalog } from "../operations/catalog.ts";
import { cliSession } from "../session.ts";
import { integer, timestampMs } from "../values.ts";
import { outputFor, table } from "../support.ts";

const HISTORY_LIMIT_MAX = 50;

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
        const types: readonly SearchType[] | undefined =
          options.type === "all" ? undefined : [options.type as SearchType];
        const result = await searchCatalog(words.join(" "), {
          ...(types !== undefined ? { types } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        outputFor(command, io).emit("search", result.data, result.message);
      },
    );

  program
    .command("show <target>")
    .description("Show a Spotify resource and its playable contents")
    .action(async (target: string, _options, command: Command) => {
      const result = await resourceDetails(target);
      outputFor(command, io).emit("show", result.data, result.message);
    });

  program
    .command("lyrics [track]")
    .description("Show lyrics for a track or the current track")
    .action(async (target: string | undefined, _options, command: Command) => {
      const result = await lyricsFor(target);
      outputFor(command, io).emit("lyrics", result.data, result.message);
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
