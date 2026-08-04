import { Command } from "commander";
import { runtimeRequest } from "../../runtime/control.ts";
import { ExitCode, usageError } from "../errors.ts";
import { normalizeRuntimePlayback, type CliIo } from "../output.ts";
import {
  openPlayback,
  pausePlayback,
  playbackStatus,
  REPEAT_MODES,
  seekPlayback,
  setRepeat,
  setShuffle,
  setVolume,
  skip,
  startPlayback,
  togglePlayback,
} from "../operations/playback.ts";
import {
  enumValue,
  mutation,
  outputFor,
  runtimePlaybackText,
  wait,
  type RunState,
} from "../support.ts";
import { booleanValue, integer, signedDurationMs, signedPercent } from "../values.ts";

export function registerPlayback(
  program: Command,
  io: CliIo,
  runState: RunState,
): void {
  program
    .command("status")
    .description("Show the current playback state")
    .option(
      "-w, --watch",
      "stream runtime state changes without polling Spotify",
    )
    .option("--interval <milliseconds>", "local watch sampling interval", "250")
    .action(
      async (
        options: { watch?: boolean; interval: string },
        command: Command,
      ) => {
        if (options.watch === true) {
          if (outputFor(command, io).mode === "json") {
            throw usageError(
              "status --watch requires --output jsonl for machine output.",
            );
          }
          const interval = integer(options.interval, "interval", 100);
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.once("SIGINT", stop);
          let previous = "";
          try {
            while (!controller.signal.aborted) {
              const value = await runtimeRequest("status", {}, {
                signal: controller.signal,
              });
              const normalized = normalizeRuntimePlayback(value);
              const serialized = JSON.stringify(normalized);
              if (serialized !== previous) {
                outputFor(command, io).emit(
                  "status",
                  normalized,
                  runtimePlaybackText(value),
                  "stream",
                );
                previous = serialized;
              }
              if (!(await wait(interval, controller.signal))) break;
            }
            runState.exitCode = ExitCode.interrupted;
          } finally {
            process.off("SIGINT", stop);
          }
          return;
        }
        const status = await playbackStatus();
        outputFor(command, io).emit("status", status.data, status.message);
      },
    );

  program
    .command("play [target]")
    .description("Resume playback or play a Spotify URI or URL")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .option("--index <number>", "one-based item position within a context")
    .action(
      async (
        target: string | undefined,
        options: { device?: string; index?: string },
        command: Command,
      ) => {
        const index =
          options.index === undefined
            ? undefined
            : integer(options.index, "index", 1);
        const result = await startPlayback({
          target,
          device: options.device,
          index,
        });
        mutation(command, io, "play", result.data, result.message);
      },
    );

  program
    .command("pause")
    .description("Pause playback")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(async (options: { device?: string }, command: Command) => {
      const result = await pausePlayback({ device: options.device });
      mutation(command, io, "pause", result.data, result.message);
    });

  program
    .command("toggle")
    .description("Toggle play and pause")
    .action(async (_options, command: Command) => {
      const result = await togglePlayback();
      mutation(command, io, "toggle", result.data, result.message);
    });

  for (const [name, description] of [
    ["next", "Skip to the next item"],
    ["previous", "Return to the previous item"],
  ] as const) {
    program
      .command(name)
      .description(description)
      .option("-d, --device <id-or-name>", "target Spotify Connect device")
      .action(async (options: { device?: string }, command: Command) => {
        const result = await skip(name, { device: options.device });
        mutation(command, io, name, result.data, result.message);
      });
  }

  program
    .command("seek <position>")
    .description("Seek to a time or by a signed duration")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(
      async (
        position: string,
        options: { device?: string },
        command: Command,
      ) => {
        const parsed = signedDurationMs(position);
        const result = await seekPlayback({
          ...(parsed.relative
            ? { offsetMs: parsed.milliseconds }
            : { positionMs: parsed.milliseconds }),
          device: options.device,
        });
        mutation(command, io, "seek", result.data, result.message);
      },
    );

  program
    .command("volume <level>")
    .description("Set volume to 0–100 or adjust it with +N/-N")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(
      async (
        level: string,
        options: { device?: string },
        command: Command,
      ) => {
        const parsed = signedPercent(level);
        const result = await setVolume({
          ...(parsed.relative
            ? { delta: parsed.percent }
            : { percent: parsed.percent }),
          device: options.device,
        });
        mutation(command, io, "volume", result.data, result.message);
      },
    );

  program
    .command("shuffle <state>")
    .description("Set shuffle to on/off, or toggle it")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(
      async (
        value: string,
        options: { device?: string },
        command: Command,
      ) => {
        const state = value === "toggle" ? ("toggle" as const) : booleanValue(value);
        const result = await setShuffle(state, { device: options.device });
        mutation(command, io, "shuffle", result.data, result.message);
      },
    );

  program
    .command("repeat <mode>")
    .description("Set repeat to off/context/track, or cycle it")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(
      async (
        value: string,
        options: { device?: string },
        command: Command,
      ) => {
        const mode =
          value === "cycle"
            ? ("cycle" as const)
            : enumValue(REPEAT_MODES, "repeat mode")(value);
        const result = await setRepeat(mode, { device: options.device });
        mutation(command, io, "repeat", result.data, result.message);
      },
    );

  program
    .command("open <target>")
    .description("Play a Spotify URI or URL")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(
      async (
        target: string,
        options: { device?: string },
        command: Command,
      ) => {
        const result = await openPlayback({ target, device: options.device });
        mutation(command, io, "open", result.data, result.message);
      },
    );
}
