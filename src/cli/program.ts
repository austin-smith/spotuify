import { Command, CommanderError, Help, Option } from "commander";
import { VERSION } from "../version.ts";
import { registerDiscovery } from "./commands/discovery.ts";
import { registerFollow } from "./commands/follow.ts";
import { registerLibrary } from "./commands/library.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerPlayback } from "./commands/playback.ts";
import { registerPlaylists } from "./commands/playlists.ts";
import { registerQueueAndDevices } from "./commands/queue-devices.ts";
import { registerSystemCommands } from "./commands/system.ts";
import { CliError, ExitCode, asCliError } from "./errors.ts";
import {
  CliOutput,
  type CliIo,
  type GlobalOutputOptions,
  type OutputMode,
} from "./output.ts";
import { CliCancelledError, CliPresenter } from "./presenter.ts";
import type { RunState } from "./support.ts";
import { signedDurationMs } from "./values.ts";

const OUTPUT_MODES: OutputMode[] = ["auto", "human", "plain", "json", "jsonl"];

const HELP_GROUP = {
  playback: "Playback",
  browse: "Browse",
  library: "Library",
  system: "Setup & system",
  general: "General options",
  output: "Output",
  composition: "Composition",
} as const;

const ROOT_COMMAND_GROUPS: Readonly<Record<string, string>> = {
  status: HELP_GROUP.playback,
  play: HELP_GROUP.playback,
  pause: HELP_GROUP.playback,
  toggle: HELP_GROUP.playback,
  next: HELP_GROUP.playback,
  previous: HELP_GROUP.playback,
  seek: HELP_GROUP.playback,
  volume: HELP_GROUP.playback,
  shuffle: HELP_GROUP.playback,
  repeat: HELP_GROUP.playback,
  queue: HELP_GROUP.playback,
  device: HELP_GROUP.playback,
  open: HELP_GROUP.playback,
  search: HELP_GROUP.browse,
  show: HELP_GROUP.browse,
  lyrics: HELP_GROUP.browse,
  library: HELP_GROUP.library,
  playlist: HELP_GROUP.library,
  follow: HELP_GROUP.library,
  history: HELP_GROUP.library,
  auth: HELP_GROUP.system,
  logout: HELP_GROUP.system,
  account: HELP_GROUP.system,
  config: HELP_GROUP.system,
  doctor: HELP_GROUP.system,
  mcp: HELP_GROUP.system,
  service: HELP_GROUP.system,
  completion: HELP_GROUP.system,
  update: HELP_GROUP.system,
  licenses: HELP_GROUP.system,
};

export interface CliDependencies {
  io?: Partial<CliIo>;
  presenter?: CliPresenter;
  richPresentation?: boolean;
}

function addGlobalOptions(program: Command): void {
  program
    .addOption(
      new Option("-o, --output <mode>", "Select the output format")
        .choices(OUTPUT_MODES)
        .helpGroup(HELP_GROUP.output),
    )
    .addOption(
      new Option("--json", "Shortcut for --output json").helpGroup(
        HELP_GROUP.output,
      ),
    )
    .addOption(
      new Option("--plain", "Use stable, undecorated text output").helpGroup(
        HELP_GROUP.output,
      ),
    )
    .addOption(
      new Option("-q, --quiet", "Suppress successful output").helpGroup(
        HELP_GROUP.output,
      ),
    )
    .addOption(
      new Option("--field <path>", "Print one field from the result").helpGroup(
        HELP_GROUP.composition,
      ),
    )
    .addOption(
      new Option(
        "--template <text>",
        "Format output using result fields",
      ).helpGroup(HELP_GROUP.composition),
    );
}

function groupRootCommands(program: Command): void {
  for (const command of program.commands) {
    const group = ROOT_COMMAND_GROUPS[command.name()];
    if (group !== undefined) command.helpGroup(group);
  }
}

function plainOutputHelp(program: Command, helper: Help): string {
  helper.helpWidth = 88;
  const groups = [HELP_GROUP.output, HELP_GROUP.composition];
  const sections = groups.flatMap((group) => {
    const options = program.options.filter(
      (option) => option.helpGroupHeading === group && !option.hidden,
    );
    if (options.length === 0) return [];
    const termWidth = Math.max(
      ...options.map((option) => helper.displayWidth(helper.optionTerm(option))),
    );
    const rows = options.map((option) =>
      helper.formatItem(
        helper.optionTerm(option),
        termWidth,
        helper.optionDescription(option),
        helper,
      ),
    );
    return [`${group}:`, ...rows, ""];
  });
  return [
    "Usage: spotuify <command> [output options]",
    "",
    ...sections,
    "Examples:",
    "  spotuify status --json",
    "  spotuify queue list --output json",
    "  spotuify status --field item.uri",
    "  spotuify status --template '{item.name} — {item.artist}'",
    "  spotuify pause --quiet",
    "",
  ].join("\n");
}

function addHelpTopics(
  program: Command,
  presenter: CliPresenter,
  io: CliIo,
  standardHelp: Help,
): void {
  program
    .command("help [command]", { hidden: true })
    .description("Display help for a command or topic")
    .helpOption(false)
    .action((name: string | undefined) => {
      if (name === "output") {
        io.stdout.write(
          presenter.richStdout
            ? presenter.formatOutputHelp(program, standardHelp)
            : plainOutputHelp(program, standardHelp),
        );
        return;
      }
      if (name === undefined) {
        program.outputHelp();
        return;
      }
      const command = program.commands.find(
        (candidate) => candidate.name() === name && candidate.name() !== "help",
      );
      if (command === undefined) program.error(`Unknown command '${name}'.`);
      command.outputHelp();
    });
}

export function createCliProgram(dependencies: CliDependencies = {}): {
  program: Command;
  state: RunState;
  io: CliIo;
  presenter: CliPresenter;
} {
  const io: CliIo = {
    stdout: dependencies.io?.stdout ?? process.stdout,
    stderr: dependencies.io?.stderr ?? process.stderr,
    env: dependencies.io?.env ?? process.env,
  };
  const presenter =
    dependencies.presenter ??
    new CliPresenter({
      stdout: io.stdout,
      stderr: io.stderr,
      env: io.env,
      rich: dependencies.richPresentation,
    });
  const state: RunState = { exitCode: ExitCode.success };
  const program = new Command();
  const standardHelp = new Help();
  const usageHint = "Run 'spotuify --help' for usage.";
  program
    .name("spotuify")
    .description("Spotify in your terminal")
    .optionsGroup(HELP_GROUP.general)
    .version(`spotuify ${VERSION}`, "-v, --version", "Show the product version")
    .addHelpOption(
      new Option("-h, --help", "Display help for command").helpGroup(
        HELP_GROUP.general,
      ),
    )
    .showHelpAfterError(usageHint)
    .helpCommand(false)
    .configureHelp({
      sortSubcommands: true,
      sortOptions: true,
      formatHelp: (command, helper) =>
        presenter.richStdout
          ? presenter.formatHelp(command, helper)
          : standardHelp.formatHelp(command, helper),
    })
    .configureOutput({
      writeOut: (text) => io.stdout.write(text),
      writeErr: (text) => {
        if (presenter.richStderr && text.trim() === usageHint) return;
        io.stderr.write(text);
      },
      getOutHasColors: () => presenter.colorStdout,
      getErrHasColors: () => presenter.colorStderr,
      outputError: (text, write) => {
        if (presenter.richStderr) {
          presenter.showCommandError(
            text.replace(/^error:\s*/i, "").trimEnd(),
            usageHint,
          );
        } else write(text);
      },
    })
    .exitOverride();
  addGlobalOptions(program);
  // Validate global formatting before an action can perform network or mutation work. Individual
  // commands construct their own formatter for emission, but this hook is the side-effect barrier.
  program.hook("preAction", (_root, actionCommand) => {
    new CliOutput(
      actionCommand.optsWithGlobals() as GlobalOutputOptions,
      io,
    );
  });
  registerPlayback(program, io, state);
  registerQueueAndDevices(program, io);
  registerDiscovery(program, io);
  registerLibrary(program, io);
  registerFollow(program, io);
  registerPlaylists(program, io);
  registerMcp(program, io, state);
  registerSystemCommands(program, io, presenter, state);
  groupRootCommands(program);
  addHelpTopics(program, presenter, io, standardHelp);
  return { program, state, io, presenter };
}

function requestedMachineOutput(argv: string[]): "json" | "jsonl" | null {
  const outputIndex = argv.findIndex(
    (argument) => argument === "--output" || argument === "-o",
  );
  if (argv.includes("--json") || argv.includes("--output=json")) return "json";
  if (argv.includes("--output=jsonl")) return "jsonl";
  const attached = argv.find((argument) => /^-o(?:json|jsonl)$/.test(argument));
  if (attached === "-ojson") return "json";
  if (attached === "-ojsonl") return "jsonl";
  const adjacent = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  return adjacent === "json" || adjacent === "jsonl" ? adjacent : null;
}

function normalizeNegativeSeek(argv: string[]): string[] {
  const commandIndex = argv.indexOf("seek");
  if (commandIndex < 0) return argv;
  const normalized = [...argv];
  for (let index = commandIndex + 1; index < normalized.length; index++) {
    const argument = normalized[index]!;
    if (argument === "-o") {
      index++;
      continue;
    }
    if (argument === "-q" || /^-o.+/.test(argument)) continue;
    if (!argument.startsWith("-") || argument.startsWith("--")) continue;
    if (/^-\d+(?:\.\d+)?$/.test(argument)) break;
    try {
      const parsed = signedDurationMs(argument);
      normalized[index] = String(parsed.milliseconds / 1_000);
    } catch {
      // Commander owns unknown-option diagnostics; only valid compact durations are normalized.
    }
    break;
  }
  return normalized;
}

function configureMachineOutput(command: Command): void {
  command.configureOutput({ writeErr: () => {}, outputError: () => {} });
  for (const child of command.commands) configureMachineOutput(child);
}

function dependenciesForPresentation(
  argv: string[],
  dependencies: CliDependencies,
): CliDependencies {
  const outputIndex = argv.findIndex(
    (argument) => argument === "--output" || argument === "-o",
  );
  const inline = argv.find((argument) => argument.startsWith("--output="));
  const output =
    inline?.slice("--output=".length) ??
    (outputIndex >= 0 ? argv[outputIndex + 1] : undefined) ??
    argv.find((argument) => /^-o.+/.test(argument))?.slice(2);
  const raw =
    argv.includes("--plain") ||
    output === "plain" ||
    argv.includes("--field") ||
    argv.some((argument) => argument.startsWith("--field=")) ||
    argv.includes("--template") ||
    argv.some((argument) => argument.startsWith("--template="));
  return raw
    ? { ...dependencies, presenter: undefined, richPresentation: false }
    : dependencies;
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const parseArgv = normalizeNegativeSeek(argv);
  const { program, state, io, presenter } = createCliProgram(
    dependenciesForPresentation(argv, dependencies),
  );
  const machineMode = requestedMachineOutput(argv);
  if (machineMode !== null) {
    // Commander normally writes parser diagnostics before throwing. Machine consumers get one
    // structured error instead, so suppress that text boundary and format it in the catch below.
    configureMachineOutput(program);
  }

  try {
    await program.parseAsync(parseArgv, { from: "user" });
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.exitCode === 0 ||
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return ExitCode.success;
      }
      if (machineMode !== null) {
        new CliOutput({ output: machineMode }, io).error(
          new CliError(
            error.message.replace(/^error:\s*/i, ""),
            ExitCode.usage,
            "usage_error",
            "Run `spotuify --help` for usage.",
          ),
        );
      }
      return ExitCode.usage;
    }
    if (error instanceof CliCancelledError) return ExitCode.interrupted;

    const cliError = asCliError(error);
    try {
      new CliOutput(
        machineMode === null
          ? (program.opts() as GlobalOutputOptions)
          : { output: machineMode },
        io,
      ).error(cliError);
    } catch {
      presenter.fatal(cliError);
    }
    return cliError.exitCode;
  }
}
