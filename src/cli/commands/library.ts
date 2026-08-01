import { Command } from "commander";
import {
  libraryContains,
  removeLibraryItems,
  saveLibraryItems,
} from "../../api/library.ts";
import { usageError } from "../errors.ts";
import type { CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { spotifyReference, spotifyUri } from "../values.ts";
import { mutation, outputFor, table } from "../support.ts";

export function registerLibrary(program: Command, io: CliIo): void {
  const library = program
    .command("library")
    .description("Inspect and change the Spotify library");
  library
    .command("contains <items...>")
    .description("Check whether URIs are saved")
    .action(async (items: string[], _options, command: Command) => {
      const uris = items.map(spotifyUri);
      const contained = await libraryContains(
        (await cliSession()).client,
        uris,
      );
      const data = uris.map((uri, index) => ({
        uri,
        saved: contained[index] ?? false,
      }));
      outputFor(command, io).emit(
        "library.contains",
        data,
        table(
          ["SAVED", "URI"],
          data.map((item) => [item.saved ? "yes" : "no", item.uri]),
        ),
      );
    });
  for (const [name, action, message] of [
    ["save", saveLibraryItems, "Saved"],
    ["remove", removeLibraryItems, "Removed"],
  ] as const) {
    library
      .command(`${name} <items...>`)
      .description(
        `${message} Spotify resources ${name === "save" ? "to" : "from"} the library`,
      )
      .action(async (items: string[], _options, command: Command) => {
        const uris = items.map((item) => {
          const ref = spotifyReference(item);
          if (
            !["track", "episode", "album", "show", "audiobook"].includes(
              ref.kind,
            )
          ) {
            throw usageError(
              `Spotify ${ref.kind} resources cannot be ${name === "save" ? "saved to" : "removed from"} the library.`,
            );
          }
          return ref.uri;
        });
        await action((await cliSession()).client, uris);
        mutation(
          command,
          io,
          `library.${name}`,
          { uris },
          `${message} ${uris.length} item${uris.length === 1 ? "" : "s"}.`,
        );
      });
  }
}
