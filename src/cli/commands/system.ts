import { Command } from "commander";
import { rm, stat } from "node:fs/promises";
import { SpotifyClient } from "../../api/client.ts";
import { authenticate, tokenStore } from "../../auth/flow.ts";
import { resolveBootProfile } from "../../auth/profile.ts";
import { prepareClientId } from "../../auth/setup.ts";
import {
  CONFIG_PATH,
  LIBRESPOT_CACHE_DIR,
  PROFILE_PATH,
  REDIRECT_URI,
  resolveClientIdWithSource,
  TOKEN_PATH,
} from "../../config.ts";
import {
  authenticateEngine,
  LibrespotEngine,
  missingEngineMessage,
} from "../../engine/librespot.ts";
import { softwareLicenses } from "../../licenses.ts";
import {
  controlPaths,
  runtimeRequest,
  tryRuntimeRequest,
} from "../../runtime/control.ts";
import { runUpdateCommand } from "../../update-command.ts";
import { VERSION } from "../../version.ts";
import { ExitCode, asCliError, unavailable, usageError } from "../errors.ts";
import { type CliIo } from "../output.ts";
import { CliPresenter } from "../presenter.ts";
import { cliSession } from "../session.ts";
import { mutation, outputFor, table, type RunState } from "../support.ts";

function requireHumanOrRawOutput(command: Command): void {
  const options = command.optsWithGlobals() as {
    json?: boolean;
    output?: string;
    field?: string;
    template?: string;
  };
  if (
    options.json === true ||
    options.output === "json" ||
    options.output === "jsonl" ||
    options.field !== undefined ||
    options.template !== undefined
  ) {
    throw usageError(
      "This command produces interactive or raw output and does not support machine formatting.",
    );
  }
}

function completionScript(shell: string, program: Command): string {
  const visible = (command: Command) =>
    command.commands.filter((child) => child.name() !== "help");
  const commands = visible(program)
    .map((command) => command.name())
    .join(" ");
  const groups = visible(program)
    .map(
      (command) =>
        [
          command.name(),
          visible(command)
            .map((child) => child.name())
            .join(" "),
        ] as const,
    )
    .filter(([, children]) => children.length > 0);
  switch (shell) {
    case "bash":
      return `# bash completion for spotuify\n_spotuify() {\n  local current="\${COMP_WORDS[COMP_CWORD]}" words='${commands}'\n  if [[ $COMP_CWORD -gt 1 ]]; then\n    case "\${COMP_WORDS[1]}" in\n${groups.map(([parent, children]) => `      ${parent}) words='${children}' ;;`).join("\n")}\n    esac\n  fi\n  COMPREPLY=( $(compgen -W "$words" -- "$current") )\n}\ncomplete -F _spotuify spotuify\n`;
    case "zsh":
      return `#compdef spotuify\n_spotuify() {\n  local context state line\n  _arguments '1:command:(${commands})' '*::argument:->args'\n  case $words[2] in\n${groups.map(([parent, children]) => `    ${parent}) _values 'command' ${children} ;;`).join("\n")}\n  esac\n}\n_spotuify "$@"\n`;
    case "fish":
      return (
        [
          ...visible(program).map(
            (command) =>
              `complete -c spotuify -f -n '__fish_use_subcommand' -a '${command.name()}' -d '${command.description().replaceAll("'", "\\'")}'`,
          ),
          ...groups.flatMap(([parent, children]) =>
            children
              .split(" ")
              .map(
                (child) =>
                  `complete -c spotuify -f -n '__fish_seen_subcommand_from ${parent}; and not __fish_seen_subcommand_from ${children}' -a '${child}'`,
              ),
          ),
        ].join("\n") + "\n"
      );
    default:
      throw usageError(
        `Unsupported shell: ${shell}.`,
        "Choose bash, zsh, or fish.",
      );
  }
}

export function registerSystemCommands(
  program: Command,
  io: CliIo,
  presenter: CliPresenter,
  state: RunState,
): void {
  program
    .command("auth")
    .description("Authorize the Web API and terminal playback")
    .option("--force", "reauthorize the Web API")
    .option("--force-engine", "reauthorize terminal playback")
    .option("--reset", "replace the configured Spotify Client ID")
    .action(
      async (
        options: {
          force?: boolean;
          forceEngine?: boolean;
          reset?: boolean;
        },
        command: Command,
      ) => {
        requireHumanOrRawOutput(command);
        presenter.beginAuth();
        const setup = await prepareClientId(
          { reset: options.reset === true },
          {
            question: () => presenter.askClientId(),
            onEvent: (event) => presenter.clientIdSetupEvent(event),
          },
        );
        presenter.checkingWebApi();
        const token = await authenticate({
          clientId: setup.clientId,
          force: setup.requiresAuthorization || options.force === true,
          onEvent: (event) => presenter.webAuthenticationEvent(event),
        });
        await setup.commit();
        const tokens = await tokenStore(setup.clientId);
        const webClient = new SpotifyClient(tokens);
        const { profile } = await resolveBootProfile(
          webClient,
          token.authorizationId,
        );
        presenter.webApiAuthorized(profile, token.expiresAt);
        if (profile?.product !== undefined && profile.product !== "premium")
          presenter.premiumWarning();

        presenter.checkingPlayback();
        let diagnostic: string | undefined;
        const playbackAuth = await authenticateEngine({
          force: options.forceEngine === true,
          onEvent: (event) => {
            if (event.type === "diagnostic") diagnostic = event.message;
            presenter.engineAuthenticationEvent(event);
          },
        });
        presenter.playbackAuthenticationResult(
          playbackAuth,
          missingEngineMessage(),
          diagnostic,
        );
        presenter.finishAuth(playbackAuth);
      },
    );

  program
    .command("logout")
    .description("Remove stored Web API and playback credentials")
    .action(async (_options, command: Command) => {
      const exists = async (path: string) =>
        await stat(path).then(
          () => true,
          () => false,
        );
      // The playback engine keeps its credentials inside its cache directory, and cached audio is
      // keyed to the signed-out account — both go together. The client ID in config.json stays:
      // logout ends the session, it does not unconfigure the application.
      const [webApi, profile, playback] = await Promise.all([
        exists(TOKEN_PATH),
        exists(PROFILE_PATH),
        exists(LIBRESPOT_CACHE_DIR),
      ]);
      await Promise.all([
        rm(TOKEN_PATH, { force: true }),
        rm(PROFILE_PATH, { force: true }),
        rm(LIBRESPOT_CACHE_DIR, { recursive: true, force: true }),
      ]);
      const runtime = await tryRuntimeRequest("ping");
      const cleared = webApi || profile || playback;
      mutation(
        command,
        io,
        "logout",
        { webApi, playback, runtimeActive: runtime.connected },
        [
          cleared ? "Signed out." : "No stored credentials were found.",
          ...(runtime.connected
            ? ["A running Spotuify session keeps its authorization until it exits."]
            : []),
        ].join("\n"),
      );
    });

  const showAccount = async (command: Command) => {
    const me = await (await cliSession()).profile();
    outputFor(command, io).emit(
      "account.show",
      me,
      `${me.display_name ?? me.id}\nAccount  ${me.id}${me.product ? `\nPlan     ${me.product}` : ""}${me.country ? `\nMarket   ${me.country}` : ""}`,
    );
  };
  program
    .command("account")
    .description("Inspect the authenticated account")
    .command("show")
    .description("Show account identity and plan")
    .action(async (_options, command: Command) => showAccount(command));

  const config = program
    .command("config")
    .description("Inspect Spotuify configuration");
  config
    .command("path")
    .description("Print the configuration file path")
    .action((_options, command: Command) => {
      outputFor(command, io).emit(
        "config.path",
        { path: CONFIG_PATH },
        CONFIG_PATH,
      );
    });
  config
    .command("show")
    .description("Show effective non-secret configuration")
    .action(async (_options, command: Command) => {
      let clientId: string | null = null;
      let source: string | null = null;
      try {
        const resolved = await resolveClientIdWithSource();
        clientId = resolved.clientId;
        source = resolved.source;
      } catch {
        // An unset client ID is meaningful configuration state, not a failure for `config show`.
      }
      const value = {
        configPath: CONFIG_PATH,
        clientId,
        clientIdSource: source,
        redirectUri: REDIRECT_URI,
      };
      outputFor(command, io).emit(
        "config.show",
        value,
        `Config       ${CONFIG_PATH}\nClient ID    ${clientId ?? "not configured"}${source ? ` (${source})` : ""}\nRedirect URI ${REDIRECT_URI}`,
      );
    });

  program
    .command("doctor")
    .description(
      "Check configuration, authentication, API access, and playback engine",
    )
    .action(async (_options, command: Command) => {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      try {
        const resolved = await resolveClientIdWithSource();
        checks.push({
          name: "configuration",
          ok: true,
          detail: `client ID from ${resolved.source}`,
        });
      } catch (error) {
        checks.push({
          name: "configuration",
          ok: false,
          detail: asCliError(error).message,
        });
      }
      try {
        const me = await (await cliSession()).profile();
        checks.push({
          name: "web_api",
          ok: true,
          detail: `${me.display_name ?? me.id} (${me.id})`,
        });
      } catch (error) {
        checks.push({
          name: "web_api",
          ok: false,
          detail: asCliError(error).message,
        });
      }
      const sidecar = await LibrespotEngine.locateSidecar();
      checks.push({
        name: "playback_engine",
        ok: sidecar !== null,
        detail: sidecar ?? missingEngineMessage(),
      });
      const runtime = await tryRuntimeRequest("ping");
      checks.push({
        name: "local_runtime",
        ok: true,
        detail: runtime.connected ? "running" : "not running (optional)",
      });
      try {
        await stat(CONFIG_PATH);
        checks.push({ name: "config_file", ok: true, detail: CONFIG_PATH });
      } catch {
        checks.push({
          name: "config_file",
          ok: true,
          detail: `not found at ${CONFIG_PATH} (optional)`,
        });
      }
      outputFor(command, io).emit(
        "doctor",
        { ok: checks.every((check) => check.ok), checks },
        table(
          ["STATUS", "CHECK", "DETAIL"],
          checks.map((check) => [
            check.ok ? "ok" : "fail",
            check.name,
            check.detail,
          ]),
        ),
      );
      if (checks.some((check) => !check.ok))
        state.exitCode = ExitCode.operational;
    });

  program
    .command("completion <shell>")
    .description("Generate shell completion for bash, zsh, or fish")
    .action((shell: string, _options, command: Command) => {
      requireHumanOrRawOutput(command);
      io.stdout.write(completionScript(shell, program));
    });

  const service = program
    .command("service")
    .description("Inspect the local command runtime");
  service
    .command("status")
    .description("Report whether a local runtime is accepting commands")
    .action(async (_options, command: Command) => {
      const runtime = await tryRuntimeRequest("ping");
      const paths = controlPaths();
      const details =
        runtime.connected &&
        runtime.value !== null &&
        typeof runtime.value === "object"
          ? (runtime.value as Record<string, unknown>)
          : {};
      const value = {
        running: runtime.connected,
        kind: details["kind"] ?? null,
        pid: details["pid"] ?? null,
        startedAt: details["startedAt"] ?? null,
        descriptorPath: paths.descriptor,
        endpoint: paths.endpoint,
      };
      outputFor(command, io).emit(
        "service.status",
        value,
        runtime.connected
          ? `Runtime is running (${String(details["kind"] ?? "unknown")}, pid ${String(details["pid"] ?? "unknown")}).\n${paths.endpoint}`
          : "Runtime is not running.",
      );
      if (!runtime.connected) state.exitCode = ExitCode.unavailable;
    });
  service
    .command("run")
    .description("Run a foreground headless playback runtime")
    .action(async (_options, command: Command) => {
      const { runHeadlessRuntime } = await import("../../runtime/service.ts");
      await runHeadlessRuntime(() => {
        outputFor(command, io).emit(
          "service.run",
          { running: true, kind: "service", pid: process.pid },
          "Headless runtime ready. Press Ctrl+C to stop.",
        );
      });
    });
  service
    .command("stop")
    .description("Stop a foreground headless runtime")
    .action(async (_options, command: Command) => {
      const runtime = await tryRuntimeRequest("ping");
      if (!runtime.connected)
        throw unavailable("No Spotuify runtime is running.");
      const details =
        runtime.value !== null && typeof runtime.value === "object"
          ? (runtime.value as Record<string, unknown>)
          : {};
      if (details["kind"] !== "service")
        throw unavailable(
          "The active runtime belongs to the TUI.",
          "Quit the TUI normally so it can restore the terminal and stop playback cleanly.",
        );
      await runtimeRequest("shutdown");
      mutation(
        command,
        io,
        "service.stop",
        { stopped: true, pid: details["pid"] ?? null },
        "Headless runtime stopping.",
      );
    });

  program
    .command("licenses")
    .description("Show software licenses and third-party notices")
    .action(async (_options, command: Command) => {
      requireHumanOrRawOutput(command);
      io.stdout.write(`${await softwareLicenses()}\n`);
    });

  program
    .command("update")
    .description("Install an update, or only check for one")
    .option("--check", "only check for an available update")
    .action(async (options: { check?: boolean }, command: Command) => {
      requireHumanOrRawOutput(command);
      presenter.beginUpdate();
      const result = await runUpdateCommand({
        currentVersion: VERSION,
        checkOnly: options.check === true,
        stdout: (message) => presenter.updateMessage(message),
        stderr: (message) => presenter.updateError(message),
      });
      presenter.finishUpdate(result.status);
      state.exitCode = result.exitCode;
    });
}
