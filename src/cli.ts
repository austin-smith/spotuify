#!/usr/bin/env bun
import { SpotifyClient } from "./api/client.ts";
import { authenticate, tokenStore } from "./auth/flow.ts";
import { resolveBootProfile, saveProfileBestEffort } from "./auth/profile.ts";
import { prepareClientId } from "./auth/setup.ts";
import type { Me } from "./api/types.ts";
import { REDIRECT_URI } from "./config.ts";
import { authenticateEngine, missingEngineMessage } from "./engine/librespot.ts";
import { runUpdateCommand } from "./update-command.ts";
import { VERSION } from "./version.ts";

/** `name (product, country)`, degrading gracefully when the scope didn't grant those fields. */
function describeAccount(me: Me): string {
  const details = [me.product, me.country].filter((d) => d !== undefined);
  const name = me.display_name ?? me.id;
  return details.length > 0 ? `${name} (${details.join(", ")})` : name;
}

const USAGE = `spotuify — spotify in ur terminal

Usage:
  spotuify auth [--force] [--force-engine] [--reset]
                             Authorize with Spotify
                             --reset  Reset Client ID and authorize
  spotuify whoami            Show the authenticated account
  spotuify licenses          Show software licenses and third-party notices
  spotuify update [--check]  Install an available update (--check only reports it)
  spotuify -v, --version     Show the product version
  spotuify                   Launch the TUI

Redirect URI to register in your Spotify app: ${REDIRECT_URI}
`;

async function main(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;

  switch (command) {
    case "auth": {
      const allowedArguments = new Set(["--force", "--force-engine", "--reset"]);
      if (
        rest.some((argument) => !allowedArguments.has(argument)) ||
        new Set(rest).size !== rest.length
      ) {
        console.error("Usage: spotuify auth [--force] [--force-engine] [--reset]");
        return 2;
      }

      const setup = await prepareClientId({ reset: rest.includes("--reset") });
      const token = await authenticate({
        clientId: setup.clientId,
        force: setup.requiresAuthorization || rest.includes("--force"),
      });
      await setup.commit();

      const tokens = await tokenStore(setup.clientId);
      const client = new SpotifyClient(tokens);
      const { profile: me } = await resolveBootProfile(client, token.authorizationId);
      if (me === null) {
        console.warn(
          "Web API authorization succeeded, but Spotify's quota is exhausted; account details are unavailable.",
        );
      } else {
        console.log(`Authenticated as ${describeAccount(me)}`);
      }
      // Only warn on a *known* non-premium account — an absent `product` is a scope gap, not free.
      if (me?.product !== undefined && me.product !== "premium") {
        console.warn("\nWarning: playback control requires Spotify Premium.");
      }
      console.log(`Token expires ${new Date(token.expiresAt).toLocaleTimeString()}.`);

      // Second, independent login: the native engine owns librespot's OAuth and credential cache.
      const playbackAuth = await authenticateEngine({
        force: rest.includes("--force-engine"),
      });
      switch (playbackAuth) {
        case "authorized":
          console.log("Playback engine authorized. spotuify will appear as a Spotify device.");
          break;
        case "missing":
          console.warn(
            "\nThe native playback engine is unavailable, so spotuify cannot play audio itself.\n" +
              `${missingEngineMessage()}\n` +
              "Without it, spotuify can only control other Spotify devices.",
          );
          break;
        case "timed-out":
          console.warn(
            "\nPlayback sign-in timed out; playback in the terminal is disabled.",
          );
          break;
        case "failed":
          console.warn(
            "\nPlayback sign-in did not complete; playback in the terminal is disabled.",
          );
          break;
      }
      return 0;
    }

    case "whoami": {
      const tokens = await tokenStore();
      const client = new SpotifyClient(tokens);
      const me = await client.get<Me>("/me");
      await saveProfileBestEffort(me, await tokens.authorizationId());
      console.log(describeAccount(me));
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;

    case "-v":
    case "--version":
      console.log(`spotuify ${VERSION}`);
      return 0;

    case "licenses": {
      const { softwareLicenses } = await import("./licenses.ts");
      console.log(await softwareLicenses());
      return 0;
    }

    case "update": {
      if (rest.some((argument) => argument !== "--check") || rest.length > 1) {
        console.error("Usage: spotuify update [--check]");
        return 2;
      }
      return await runUpdateCommand({
        currentVersion: VERSION,
        checkOnly: rest.includes("--check"),
      });
    }

    default:
      if (command !== undefined) {
        console.error(`Unknown command: ${command}\n`);
        console.error(USAGE);
        return 2;
      }
      // No subcommand: launch the TUI. Imported lazily so CLI paths never construct a renderer.
      await import("./index.tsx");
      // The renderer owns the process from here; exiting would tear it down immediately.
      return null;
  }
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
