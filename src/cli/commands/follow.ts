import { Command } from "commander";
import { followedArtists } from "../../api/follow.ts";
import { removeLibraryItems, saveLibraryItems } from "../../api/library.ts";
import { usageError } from "../errors.ts";
import type { CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { spotifyReference } from "../values.ts";
import { mutation, outputFor, table } from "../support.ts";

function followUri(item: string): string {
  const ref = spotifyReference(item);
  if (ref.kind !== "artist" && ref.kind !== "user") {
    throw usageError(
      `Spotify ${ref.kind} resources cannot be followed.`,
      "Follow artists and users; save other resources with `spotuify library save`.",
    );
  }
  return ref.uri;
}

export function registerFollow(program: Command, io: CliIo): void {
  const follow = program
    .command("follow")
    .description("Follow artists and users");
  follow
    .command("list")
    .description("List followed artists")
    .action(async (_options, command: Command) => {
      const artists = await followedArtists((await cliSession()).client);
      outputFor(command, io).emit(
        "follow.list",
        artists.map((artist) => ({
          id: artist.id,
          uri: artist.uri,
          name: artist.name,
          genres: artist.genres ?? [],
          followers: artist.followers?.total ?? null,
        })),
        table(
          ["NAME", "GENRES", "URI"],
          artists.map((artist) => [
            artist.name,
            (artist.genres ?? []).slice(0, 3).join(", "),
            artist.uri,
          ]),
        ),
      );
    });
  for (const [name, action, message] of [
    ["add", saveLibraryItems, "Followed"],
    ["remove", removeLibraryItems, "Unfollowed"],
  ] as const) {
    follow
      .command(`${name} <items...>`)
      .description(
        name === "add"
          ? "Follow artists or users"
          : "Unfollow artists or users",
      )
      .action(async (items: string[], _options, command: Command) => {
        const uris = items.map(followUri);
        await action((await cliSession()).client, uris);
        mutation(
          command,
          io,
          `follow.${name}`,
          { uris },
          `${message} ${uris.length} ${uris.length === 1 ? "profile" : "profiles"}.`,
        );
      });
  }
}
