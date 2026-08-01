import { Command, Option } from "commander";
import { removeLibraryItems, saveLibraryItems } from "../../api/library.ts";
import {
  addPlaylistItems,
  createPlaylist,
  movePlaylistItems,
  myPlaylists,
  playlistDetails,
  playlistItems,
  removePlaylistItems,
  replacePlaylistItems,
  updatePlaylistDetails,
} from "../../api/playlists.ts";
import { artistLine } from "../../api/types.ts";
import { unavailable, usageError } from "../errors.ts";
import { formatDuration, normalizeItem, type CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { integer, spotifyReference } from "../values.ts";
import {
  mutation,
  normalizePlaylistDetails,
  outputFor,
  playlistHeader,
  playlistId,
  table,
} from "../support.ts";

export function registerPlaylists(program: Command, io: CliIo): void {
  const playlist = program
    .command("playlist")
    .description("Create, inspect, and edit playlists");
  playlist
    .command("list")
    .description("List the user's playlists")
    .option("--owned", "show only owned playlists")
    .action(async (options: { owned?: boolean }, command: Command) => {
      const session = await cliSession();
      const me = await session.profile();
      const { client } = session;
      const all = (await myPlaylists(client, me.id)).filter(
        (item) => options.owned !== true || item.mine,
      );
      outputFor(command, io).emit(
        "playlist.list",
        all,
        table(
          ["OWNED", "NAME", "OWNER", "URI"],
          all.map((item) => [
            item.mine ? "yes" : "no",
            item.name,
            item.ownerName,
            item.uri,
          ]),
        ),
      );
    });
  playlist
    .command("show <playlist>")
    .description("Show an owned or collaborative playlist")
    .action(async (value: string, _options, command: Command) => {
      const { client } = await cliSession();
      const id = playlistId(value);
      const [details, entries] = await Promise.all([
        playlistDetails(client, id),
        playlistItems(client, id),
      ]);
      const data = {
        playlist: normalizePlaylistDetails(details),
        items: entries.map((entry) => ({
          position: entry.position,
          isLocal: entry.isLocal,
          item: normalizeItem(entry.item),
        })),
      };
      outputFor(command, io).emit(
        "playlist.show",
        data,
        `${playlistHeader(details)}\n\n${table(
          ["#", "TITLE", "ARTIST", "TIME", "URI"],
          entries.map((entry) => [
            entry.position + 1,
            entry.item.name,
            artistLine(entry.item),
            formatDuration(entry.item.duration_ms),
            entry.item.uri,
          ]),
        )}`,
      );
    });
  playlist
    .command("create <name>")
    .description("Create an empty playlist")
    .option("--public", "create a public playlist")
    .option("--collaborative", "create a private collaborative playlist")
    .option("--description <text>", "playlist description")
    .action(
      async (
        name: string,
        options: {
          public?: boolean;
          collaborative?: boolean;
          description?: string;
        },
        command: Command,
      ) => {
        if (name.trim().length === 0) {
          throw usageError("Playlist name cannot be empty.");
        }
        if (options.public === true && options.collaborative === true) {
          throw usageError("A collaborative playlist must be private.");
        }
        const created = await createPlaylist((await cliSession()).client, {
          name,
          public: options.public === true,
          collaborative: options.collaborative === true,
          description: options.description,
        });
        mutation(
          command,
          io,
          "playlist.create",
          { ...created },
          `Created ${created.name}.\n${created.uri}`,
        );
      },
    );
  playlist
    .command("delete <playlist>")
    .description("Delete an owned playlist")
    .action(async (value: string, _options, command: Command) => {
      const session = await cliSession();
      const id = playlistId(value);
      // Spotify deletes by unfollowing, and unfollowing succeeds on any playlist — so a wrong URI
      // would silently unfollow instead of failing. Ownership is what makes this command honest.
      const [details, me] = await Promise.all([
        playlistDetails(session.client, id),
        session.profile(),
      ]);
      if (details.ownerId !== me.id) {
        throw unavailable(
          `Playlist ${details.name} belongs to ${details.ownerName}.`,
          "Use `spotuify playlist unfollow` to remove it from your library.",
        );
      }
      await removeLibraryItems(session.client, [details.uri]);
      mutation(
        command,
        io,
        "playlist.delete",
        { playlist: details.uri, name: details.name },
        `Deleted ${details.name}.`,
      );
    });
  playlist
    .command("follow <playlist>")
    .description("Add a playlist to the library")
    .action(async (value: string, _options, command: Command) => {
      const uri = spotifyReference(value, "playlist").uri;
      await saveLibraryItems((await cliSession()).client, [uri]);
      mutation(
        command,
        io,
        "playlist.follow",
        { playlist: uri },
        "Playlist added to the library.",
      );
    });
  playlist
    .command("unfollow <playlist>")
    .description("Remove a playlist from the library")
    .action(async (value: string, _options, command: Command) => {
      const uri = spotifyReference(value, "playlist").uri;
      await removeLibraryItems((await cliSession()).client, [uri]);
      mutation(
        command,
        io,
        "playlist.unfollow",
        { playlist: uri },
        "Playlist removed from the library.",
      );
    });
  playlist
    .command("edit <playlist>")
    .description("Change playlist details")
    .option("--name <name>", "new name")
    .option("--description <text>", "new description")
    .addOption(
      new Option("--visibility <value>", "public or private").choices([
        "public",
        "private",
      ]),
    )
    .addOption(
      new Option("--collaborative <value>", "on or off").choices(["on", "off"]),
    )
    .action(
      async (
        value: string,
        options: {
          name?: string;
          description?: string;
          visibility?: string;
          collaborative?: string;
        },
        command: Command,
      ) => {
        const changes: {
          name?: string;
          description?: string;
          public?: boolean;
          collaborative?: boolean;
        } = {
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.description !== undefined
            ? { description: options.description }
            : {}),
          ...(options.visibility !== undefined
            ? { public: options.visibility === "public" }
            : {}),
          ...(options.collaborative !== undefined
            ? { collaborative: options.collaborative === "on" }
            : {}),
        };
        if (Object.keys(changes).length === 0) {
          throw usageError("At least one playlist change is required.");
        }
        if (options.name !== undefined && options.name.trim().length === 0) {
          throw usageError("Playlist name cannot be empty.");
        }
        if (
          options.visibility === "public" &&
          options.collaborative === "on"
        ) {
          throw usageError("A collaborative playlist must be private.");
        }
        if (
          options.collaborative === "on" &&
          options.visibility === undefined
        ) {
          changes.public = false;
        }
        if (
          options.visibility === "public" &&
          options.collaborative === undefined
        ) {
          changes.collaborative = false;
        }
        await updatePlaylistDetails(
          (await cliSession()).client,
          playlistId(value),
          changes,
        );
        mutation(
          command,
          io,
          "playlist.edit",
          { playlist: spotifyReference(value, "playlist").uri, changes },
          "Playlist details updated.",
        );
      },
    );
  playlist
    .command("add <playlist> <items...>")
    .description("Append tracks or episodes to a playlist")
    .action(
      async (
        value: string,
        items: string[] = [],
        _options,
        command: Command,
      ) => {
        const uris = items.map((item) => {
          const ref = spotifyReference(item);
          if (ref.kind !== "track" && ref.kind !== "episode")
            throw usageError("Playlists accept tracks and episodes only.");
          return ref.uri;
        });
        const snapshotId = await addPlaylistItems(
          (await cliSession()).client,
          playlistId(value),
          uris,
        );
        mutation(
          command,
          io,
          "playlist.add",
          {
            playlist: spotifyReference(value, "playlist").uri,
            uris,
            snapshotId,
          },
          `Added ${uris.length} item${uris.length === 1 ? "" : "s"}.`,
        );
      },
    );
  playlist
    .command("remove <playlist> <items...>")
    .description("Remove all occurrences of tracks or episodes")
    .option("--snapshot <id>", "require a specific playlist snapshot")
    .action(
      async (
        value: string,
        items: string[],
        options: { snapshot?: string },
        command: Command,
      ) => {
        const uris = items.map((item) => {
          const ref = spotifyReference(item);
          if (ref.kind !== "track" && ref.kind !== "episode")
            throw usageError("Playlists contain tracks and episodes only.");
          return ref.uri;
        });
        const snapshotId = await removePlaylistItems(
          (await cliSession()).client,
          playlistId(value),
          uris,
          options.snapshot,
        );
        mutation(
          command,
          io,
          "playlist.remove",
          {
            playlist: spotifyReference(value, "playlist").uri,
            uris,
            snapshotId,
          },
          `Removed ${uris.length} item${uris.length === 1 ? "" : "s"}.`,
        );
      },
    );
  playlist
    .command("move <playlist>")
    .description("Move a contiguous item range")
    .requiredOption("--from <index>", "one-based first item")
    .requiredOption("--before <index>", "one-based insertion position")
    .option("--length <number>", "number of items", "1")
    .option("--snapshot <id>", "require a specific playlist snapshot")
    .action(
      async (
        value: string,
        options: {
          from: string;
          before: string;
          length: string;
          snapshot?: string;
        },
        command: Command,
      ) => {
        const from = integer(options.from, "from", 1) - 1;
        const before = integer(options.before, "before", 1) - 1;
        const length = integer(options.length, "length", 1);
        const snapshotId = await movePlaylistItems(
          (await cliSession()).client,
          playlistId(value),
          { from, before, length, snapshotId: options.snapshot },
        );
        mutation(
          command,
          io,
          "playlist.move",
          {
            playlist: spotifyReference(value, "playlist").uri,
            from: from + 1,
            before: before + 1,
            length,
            snapshotId,
          },
          `Moved ${length} item${length === 1 ? "" : "s"}.`,
        );
      },
    );

  playlist
    .command("replace <playlist> [items...]")
    .description(
      "Replace every item, or clear the playlist when none are supplied",
    )
    .action(
      async (value: string, items: string[], _options, command: Command) => {
        const uris = items.map((item) => {
          const ref = spotifyReference(item);
          if (ref.kind !== "track" && ref.kind !== "episode") {
            throw usageError("Playlists contain tracks and episodes only.");
          }
          return ref.uri;
        });
        const snapshotId = await replacePlaylistItems(
          (await cliSession()).client,
          playlistId(value),
          uris,
        );
        mutation(
          command,
          io,
          "playlist.replace",
          {
            playlist: spotifyReference(value, "playlist").uri,
            uris,
            snapshotId,
          },
          uris.length === 0
            ? "Playlist cleared."
            : `Replaced the playlist with ${uris.length} item${uris.length === 1 ? "" : "s"}.`,
        );
      },
    );
}
