#!/usr/bin/env bun
import { SpotifyClient } from "./api/client.ts";
import { authenticate, tokenStore } from "./auth/flow.ts";
import { resolveBootProfile, saveProfileBestEffort } from "./auth/profile.ts";
import { prepareClientId } from "./auth/setup.ts";
import type { Me } from "./api/types.ts";
import { CliCancelledError, CliPresenter } from "./cli/presenter.ts";
import { authenticateEngine, missingEngineMessage } from "./engine/librespot.ts";
import { runUpdateCommand } from "./update-command.ts";
import { UPDATE_AVAILABLE_EXIT_CODE } from "./update.ts";
import { VERSION } from "./version.ts";

async function main(argv: string[], presenter: CliPresenter): Promise<number | null> {
  const [command, ...rest] = argv;

  switch (command) {
    case "auth": {
      const allowedArguments = new Set(["--force", "--force-engine", "--reset"]);
      if (
        rest.some((argument) => !allowedArguments.has(argument)) ||
        new Set(rest).size !== rest.length
      ) {
        presenter.usageError("Invalid auth options.", "auth");
        return 2;
      }

      presenter.beginAuth();
      const setup = await prepareClientId(
        { reset: rest.includes("--reset") },
        {
          question: () => presenter.askClientId(),
          onEvent: (event) => presenter.clientIdSetupEvent(event),
        },
      );
      presenter.checkingWebApi();
      const token = await authenticate({
        clientId: setup.clientId,
        force: setup.requiresAuthorization || rest.includes("--force"),
        onEvent: (event) => presenter.webAuthenticationEvent(event),
      });
      await setup.commit();

      const tokens = await tokenStore(setup.clientId);
      const client = new SpotifyClient(tokens);
      const { profile: me } = await resolveBootProfile(client, token.authorizationId);
      presenter.webApiAuthorized(me, token.expiresAt);
      // Only warn on a *known* non-premium account — an absent `product` is a scope gap, not free.
      if (me?.product !== undefined && me.product !== "premium") {
        presenter.premiumWarning();
      }

      // Second, independent login: the native engine owns librespot's OAuth and credential cache.
      presenter.checkingPlayback();
      let playbackDiagnostic: string | undefined;
      const playbackAuth = await authenticateEngine({
        force: rest.includes("--force-engine"),
        onEvent: (event) => {
          if (event.type === "diagnostic") playbackDiagnostic = event.message;
          presenter.engineAuthenticationEvent(event);
        },
      });
      presenter.playbackAuthenticationResult(
        playbackAuth,
        missingEngineMessage(),
        playbackDiagnostic,
      );
      presenter.finishAuth(playbackAuth);
      return 0;
    }

    case "whoami": {
      const tokens = await tokenStore();
      const client = new SpotifyClient(tokens);
      const me = await client.get<Me>("/me");
      await saveProfileBestEffort(me, await tokens.authorizationId());
      presenter.showAccount(me);
      return 0;
    }

    case "help":
    case "--help":
    case "-h":
      presenter.showHelp();
      return 0;

    case "-v":
    case "--version":
      console.log(`spotuify ${VERSION}`);
      return 0;

    case "licenses": {
      const { softwareLicenses } = await import("./licenses.ts");
      await Bun.write(Bun.stdout, `${await softwareLicenses()}\n`);
      return 0;
    }

    case "update": {
      if (rest.some((argument) => argument !== "--check") || rest.length > 1) {
        presenter.usageError("Invalid update options.", "update");
        return 2;
      }
      presenter.beginUpdate();
      const code = await runUpdateCommand({
        currentVersion: VERSION,
        checkOnly: rest.includes("--check"),
        stdout: (message) => presenter.updateMessage(message),
        stderr: (message) => presenter.updateError(message),
      });
      presenter.finishUpdate(code === 0, code === UPDATE_AVAILABLE_EXIT_CODE);
      return code;
    }

    default:
      if (command !== undefined) {
        presenter.usageError(`Unknown command: ${command}`, "unknown");
        return 2;
      }
      // No subcommand: launch the TUI. Imported lazily so CLI paths never construct a renderer.
      await import("./index.tsx");
      // The renderer owns the process from here; exiting would tear it down immediately.
      return null;
  }
}

const presenter = new CliPresenter();
try {
  const code = await main(process.argv.slice(2), presenter);
  if (code !== null) process.exitCode = code;
} catch (err) {
  if (err instanceof CliCancelledError) process.exitCode = 130;
  else {
    presenter.fatal(err);
    process.exitCode = 1;
  }
}
