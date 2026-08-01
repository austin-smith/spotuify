import { Command } from "commander";
import { nextRepeatState } from "../../api/player.ts";
import type { RepeatState } from "../../api/types.ts";
import { runtimeRequest, tryRuntimeRequest } from "../../runtime/control.ts";
import { ExitCode, unavailable, usageError } from "../errors.ts";
import {
  formatDuration,
  normalizePlayback,
  normalizeRuntimePlayback,
  playbackText,
  type CliIo,
} from "../output.ts";
import { cliSession } from "../session.ts";
import {
  booleanValue,
  integer,
  signedDurationMs,
  signedPercent,
  spotifyReference,
} from "../values.ts";
import {
  currentState,
  enumValue,
  mutation,
  outputFor,
  runtimeBoolean,
  runtimeNumber,
  runtimePlaybackText,
  selectedDevice,
  wait,
  type RunState,
} from "../support.ts";

const REPEAT_MODES: RepeatState[] = ["off", "context", "track"];

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
        const runtime = await tryRuntimeRequest("status");
        if (runtime.connected) {
          outputFor(command, io).emit(
            "status",
            normalizeRuntimePlayback(runtime.value),
            runtimePlaybackText(runtime.value),
          );
          return;
        }
        const state = await currentState();
        outputFor(command, io).emit(
          "status",
          normalizePlayback(state),
          playbackText(state),
        );
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
            : integer(options.index, "index", 1) - 1;
        if (index !== undefined && target === undefined) {
          throw usageError(
            "--index requires an album or playlist target.",
          );
        }
        const ref = target === undefined ? undefined : spotifyReference(target);
        if (
          ref !== undefined &&
          index !== undefined &&
          ref.kind !== "album" &&
          ref.kind !== "playlist"
        ) {
          throw usageError(
            "--index is only valid for album or playlist contexts.",
          );
        }
        if (ref?.kind === "show") {
          throw usageError(
            "Spotify shows cannot be played as a context. Use an episode URI instead.",
          );
        }
        if (
          ref !== undefined &&
          !["track", "episode", "album", "artist", "playlist"].includes(
            ref.kind,
          )
        ) {
          throw usageError(`Spotify ${ref.kind} resources cannot be played.`);
        }
        if (options.device === undefined) {
          const runtimeParams =
            ref === undefined
              ? {}
              : ref.kind === "track" || ref.kind === "episode"
                ? { uris: [ref.uri] }
                : { contextUri: ref.uri, offset: index };
          const runtime = await tryRuntimeRequest("play", runtimeParams);
          if (runtime.connected) {
            mutation(
              command,
              io,
              "play",
              {
                source: "runtime",
                target: target ?? null,
                state: runtime.value,
              },
              target === undefined ? "Playback resumed." : `Playing ${target}.`,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        if (ref === undefined) await player.play({ deviceId });
        else {
          if (ref.kind === "track" || ref.kind === "episode") {
            await player.play({ deviceId, uris: [ref.uri] });
          } else {
            await player.play({ deviceId, contextUri: ref.uri, offset: index });
          }
        }
        mutation(
          command,
          io,
          "play",
          { target: target ?? null, deviceId: deviceId ?? null },
          target === undefined ? "Playback resumed." : `Playing ${target}.`,
        );
      },
    );

  program
    .command("pause")
    .description("Pause playback")
    .option("-d, --device <id-or-name>", "target Spotify Connect device")
    .action(async (options: { device?: string }, command: Command) => {
      if (options.device === undefined) {
        const runtime = await tryRuntimeRequest("pause");
        if (runtime.connected) {
          mutation(
            command,
            io,
            "pause",
            { source: "runtime", state: runtime.value },
            "Playback paused.",
          );
          return;
        }
      }
      const { player } = await cliSession();
      const deviceId =
        options.device === undefined
          ? undefined
          : (await selectedDevice(options.device)).id;
      await player.pause(deviceId);
      mutation(
        command,
        io,
        "pause",
        { deviceId: deviceId ?? null },
        "Playback paused.",
      );
    });

  program
    .command("toggle")
    .description("Toggle play and pause")
    .action(async (_options, command: Command) => {
      const runtime = await tryRuntimeRequest("toggle");
      if (runtime.connected) {
        const playing = runtimeBoolean(runtime.value, "isPlaying") === true;
        mutation(
          command,
          io,
          "toggle",
          { source: "runtime", isPlaying: playing, state: runtime.value },
          playing ? "Playback resumed." : "Playback paused.",
        );
        return;
      }
      const { player } = await cliSession();
      const state = await player.state("foreground");
      if (state?.is_playing === true) await player.pause();
      else await player.play();
      mutation(
        command,
        io,
        "toggle",
        { isPlaying: state?.is_playing !== true },
        state?.is_playing === true ? "Playback paused." : "Playback resumed.",
      );
    });

  for (const [name, description] of [
    ["next", "Skip to the next item"],
    ["previous", "Return to the previous item"],
  ] as const) {
    program
      .command(name)
      .description(description)
      .action(async (_options, command: Command) => {
        const runtime = await tryRuntimeRequest(name);
        if (runtime.connected) {
          mutation(
            command,
            io,
            name,
            { source: "runtime", state: runtime.value },
            name === "next"
              ? "Skipped to next item."
              : "Returned to previous item.",
          );
          return;
        }
        const { player } = await cliSession();
        await player[name]();
        mutation(
          command,
          io,
          name,
          {},
          name === "next"
            ? "Skipped to next item."
            : "Returned to previous item.",
        );
      });
  }

  program
    .command("seek <position>")
    .description("Seek to a time or by a signed duration")
    .action(async (position: string, _options, command: Command) => {
      const parsed = signedDurationMs(position);
      let target = parsed.milliseconds;
      const runtimeStatus = await tryRuntimeRequest("status");
      if (runtimeStatus.connected) {
        if (parsed.relative) {
          const progress = runtimeNumber(runtimeStatus.value, "progressMs");
          if (progress === null) throw unavailable("Nothing is playing.");
          target += progress;
        }
        target = Math.max(0, target);
        const result = await runtimeRequest("seek", { positionMs: target });
        mutation(
          command,
          io,
          "seek",
          { source: "runtime", positionMs: target, state: result },
          `Seeked to ${formatDuration(target)}.`,
        );
        return;
      }
      const { player } = await cliSession();
      if (parsed.relative) {
        const state = await player.state("foreground");
        if (state === null) throw unavailable("Nothing is playing.");
        if (state.progress_ms === null) {
          throw unavailable("The current playback position is unavailable.");
        }
        target += state.progress_ms;
      }
      target = Math.max(0, target);
      await player.seek(target);
      mutation(
        command,
        io,
        "seek",
        { positionMs: target },
        `Seeked to ${formatDuration(target)}.`,
      );
    });

  program
    .command("volume <level>")
    .description("Set volume to 0–100 or adjust it with +N/-N")
    .action(async (level: string, _options, command: Command) => {
      const parsed = signedPercent(level);
      let percent = parsed.percent;
      const runtimeStatus = await tryRuntimeRequest("status");
      if (runtimeStatus.connected) {
        if (parsed.relative) {
          const value = runtimeStatus.value;
          const device =
            value !== null && typeof value === "object"
              ? (value as Record<string, unknown>)["device"]
              : null;
          const current =
            device !== null && typeof device === "object"
              ? (device as Record<string, unknown>)["volumePercent"]
              : null;
          if (typeof current !== "number")
            throw unavailable("The active device does not report its volume.");
          percent += current;
        }
        percent = Math.max(0, Math.min(100, Math.round(percent)));
        const result = await runtimeRequest("volume", { percent });
        mutation(
          command,
          io,
          "volume",
          { source: "runtime", volumePercent: percent, state: result },
          `Volume set to ${percent}%.`,
        );
        return;
      }
      const { player } = await cliSession();
      if (parsed.relative) {
        const state = await player.state("foreground");
        if (state?.device === null || state?.device === undefined)
          throw unavailable("No active playback device.");
        if (state.device.volume_percent === null)
          throw unavailable("The active device does not report its volume.");
        percent += state.device.volume_percent;
      }
      percent = Math.max(0, Math.min(100, Math.round(percent)));
      await player.setVolume(percent);
      mutation(
        command,
        io,
        "volume",
        { volumePercent: percent },
        `Volume set to ${percent}%.`,
      );
    });

  program
    .command("shuffle <state>")
    .description("Set shuffle to on/off, or toggle it")
    .action(async (value: string, _options, command: Command) => {
      const runtimeStatus = await tryRuntimeRequest("status");
      if (runtimeStatus.connected) {
        const current = runtimeBoolean(runtimeStatus.value, "shuffle") ?? false;
        const enabled = value === "toggle" ? !current : booleanValue(value);
        const result = await runtimeRequest("shuffle", { enabled });
        mutation(
          command,
          io,
          "shuffle",
          { source: "runtime", shuffle: enabled, state: result },
          `Shuffle ${enabled ? "on" : "off"}.`,
        );
        return;
      }
      const { player } = await cliSession();
      const state =
        value === "toggle"
          ? !(await player.state("foreground"))?.shuffle_state
          : booleanValue(value);
      await player.setShuffle(state);
      mutation(
        command,
        io,
        "shuffle",
        { shuffle: state },
        `Shuffle ${state ? "on" : "off"}.`,
      );
    });

  program
    .command("repeat <mode>")
    .description("Set repeat to off/context/track, or cycle it")
    .action(async (value: string, _options, command: Command) => {
      let mode: RepeatState;
      const runtimeStatus = await tryRuntimeRequest("status");
      if (runtimeStatus.connected) {
        const stateValue =
          runtimeStatus.value !== null &&
          typeof runtimeStatus.value === "object"
            ? (runtimeStatus.value as Record<string, unknown>)["repeat"]
            : "off";
        const current = REPEAT_MODES.includes(stateValue as RepeatState)
          ? (stateValue as RepeatState)
          : "off";
        mode =
          value === "cycle"
            ? nextRepeatState(current)
            : enumValue(REPEAT_MODES, "repeat mode")(value);
        const result = await runtimeRequest("repeat", { mode });
        mutation(
          command,
          io,
          "repeat",
          { source: "runtime", repeat: mode, state: result },
          `Repeat set to ${mode}.`,
        );
        return;
      }
      const { player } = await cliSession();
      if (value === "cycle")
        mode = nextRepeatState(
          (await player.state("foreground"))?.repeat_state ?? "off",
        );
      else mode = enumValue(REPEAT_MODES, "repeat mode")(value);
      await player.setRepeat(mode);
      mutation(
        command,
        io,
        "repeat",
        { repeat: mode },
        `Repeat set to ${mode}.`,
      );
    });

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
        const ref = spotifyReference(target);
        if (
          !["track", "episode", "album", "artist", "playlist"].includes(
            ref.kind,
          )
        ) {
          if (ref.kind === "show") {
            throw usageError(
              "Spotify shows cannot be played as a context. Use an episode URI instead.",
            );
          }
          throw usageError(`Spotify ${ref.kind} resources cannot be played.`);
        }
        if (options.device === undefined) {
          const params =
            ref.kind === "track" || ref.kind === "episode"
              ? { uris: [ref.uri] }
              : { contextUri: ref.uri };
          const runtime = await tryRuntimeRequest("play", params);
          if (runtime.connected) {
            mutation(
              command,
              io,
              "open",
              { source: "runtime", uri: ref.uri, state: runtime.value },
              `Playing ${ref.uri}.`,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        if (ref.kind === "track" || ref.kind === "episode")
          await player.play({ deviceId, uris: [ref.uri] });
        else if (["album", "artist", "playlist"].includes(ref.kind))
          await player.play({ deviceId, contextUri: ref.uri });
        else
          throw usageError(`Spotify ${ref.kind} resources cannot be played.`);
        mutation(
          command,
          io,
          "open",
          { uri: ref.uri, deviceId: deviceId ?? null },
          `Playing ${ref.uri}.`,
        );
      },
    );
}
