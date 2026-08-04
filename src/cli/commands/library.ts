import { Command } from "commander";
import { removeLibraryItems, saveLibraryItems } from "../../api/library.ts";
import type { CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { libraryUri } from "../values.ts";
import { mutation } from "../support.ts";

export function registerLibrary(program: Command, io: CliIo): void {
  const library = program
    .command("library")
    .description("Change the Spotify library");
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
        const uris = items.map((item) =>
          libraryUri(
            item,
            name === "save"
              ? "cannot be saved to the library"
              : "cannot be removed from the library",
          ),
        );
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
