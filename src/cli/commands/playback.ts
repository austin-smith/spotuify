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
            "Spotify shows cannot be played as a context. Play one of its episodes instead — `spotuify show <show-uri>` lists them.",
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
      .option("-d, --device <id-or-name>", "target Spotify Connect device")
      .action(async (options: { device?: string }, command: Command) => {
        const message =
          name === "next"
            ? "Skipped to next item."
            : "Returned to previous item.";
        if (options.device === undefined) {
          const runtime = await tryRuntimeRequest(name);
          if (runtime.connected) {
            mutation(
              command,
              io,
              name,
              { source: "runtime", state: runtime.value },
              message,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        await player[name](deviceId);
        mutation(command, io, name, { deviceId: deviceId ?? null }, message);
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
        let target = parsed.milliseconds;
        if (options.device === undefined) {
          // A relative seek is sent as the raw offset: the runtime applies it inside its
          // serialized mutation, so two concurrent `seek +5s` commands both land.
          const runtime = await tryRuntimeRequest(
            "seek",
            parsed.relative
              ? { offsetMs: parsed.milliseconds }
              : { positionMs: Math.max(0, parsed.milliseconds) },
          );
          if (runtime.connected) {
            const position =
              runtimeNumber(runtime.value, "progressMs") ??
              Math.max(0, parsed.milliseconds);
            mutation(
              command,
              io,
              "seek",
              { source: "runtime", positionMs: position, state: runtime.value },
              `Seeked to ${formatDuration(position)}.`,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        if (parsed.relative) {
          const state = await player.state("foreground");
          if (state === null) throw unavailable("Nothing is playing.");
          if (state.progress_ms === null) {
            throw unavailable("The current playback position is unavailable.");
          }
          target += state.progress_ms;
        }
        target = Math.max(0, target);
        await player.seek(target, deviceId);
        mutation(
          command,
          io,
          "seek",
          { positionMs: target, deviceId: deviceId ?? null },
          `Seeked to ${formatDuration(target)}.`,
        );
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
        let percent = parsed.percent;
        if (options.device === undefined) {
          // A relative change is sent as the raw delta and applied inside the runtime's
          // serialized mutation, so two concurrent `volume +5` commands both land.
          const runtime = await tryRuntimeRequest(
            "volume",
            parsed.relative
              ? { delta: Math.round(parsed.percent) }
              : { percent: Math.round(parsed.percent) },
          );
          if (runtime.connected) {
            const device =
              runtime.value !== null && typeof runtime.value === "object"
                ? (runtime.value as Record<string, unknown>)["device"]
                : null;
            const volume =
              device !== null && typeof device === "object"
                ? (device as Record<string, unknown>)["volumePercent"]
                : null;
            mutation(
              command,
              io,
              "volume",
              {
                source: "runtime",
                volumePercent: typeof volume === "number" ? volume : null,
                state: runtime.value,
              },
              typeof volume === "number"
                ? `Volume set to ${volume}%.`
                : "Volume adjusted.",
            );
            return;
          }
        }
        const { player } = await cliSession();
        const device =
          options.device === undefined
            ? undefined
            : await selectedDevice(options.device);
        if (parsed.relative) {
          // A targeted device reports its own volume; only the untargeted path needs playback state.
          let current: number | null;
          if (device !== undefined) current = device.volume_percent;
          else {
            const state = await player.state("foreground");
            if (state?.device === null || state?.device === undefined)
              throw unavailable("No active playback device.");
            current = state.device.volume_percent;
          }
          if (current === null)
            throw unavailable("The device does not report its volume.");
          percent += current;
        }
        percent = Math.max(0, Math.min(100, Math.round(percent)));
        await player.setVolume(percent, device?.id);
        mutation(
          command,
          io,
          "volume",
          { volumePercent: percent, deviceId: device?.id ?? null },
          `Volume set to ${percent}%.`,
        );
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
        if (options.device === undefined) {
          // `toggle` is sent as the toggle itself so the runtime flips its own serialized state;
          // resolving it here from a status read would race a concurrent toggle.
          const runtime = await tryRuntimeRequest(
            "shuffle",
            value === "toggle"
              ? { toggle: true }
              : { enabled: booleanValue(value) },
          );
          if (runtime.connected) {
            const enabled = runtimeBoolean(runtime.value, "shuffle") ?? false;
            mutation(
              command,
              io,
              "shuffle",
              { source: "runtime", shuffle: enabled, state: runtime.value },
              `Shuffle ${enabled ? "on" : "off"}.`,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        const state =
          value === "toggle"
            ? !(await player.state("foreground"))?.shuffle_state
            : booleanValue(value);
        await player.setShuffle(state, deviceId);
        mutation(
          command,
          io,
          "shuffle",
          { shuffle: state, deviceId: deviceId ?? null },
          `Shuffle ${state ? "on" : "off"}.`,
        );
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
        let mode: RepeatState;
        if (options.device === undefined) {
          // `cycle` is sent as the cycle itself so the runtime advances its own serialized state;
          // resolving it here from a status read would race a concurrent cycle.
          const runtime = await tryRuntimeRequest(
            "repeat",
            {
              mode:
                value === "cycle"
                  ? "cycle"
                  : enumValue(REPEAT_MODES, "repeat mode")(value),
            },
          );
          if (runtime.connected) {
            const stateValue =
              runtime.value !== null && typeof runtime.value === "object"
                ? (runtime.value as Record<string, unknown>)["repeat"]
                : "off";
            const applied = REPEAT_MODES.includes(stateValue as RepeatState)
              ? (stateValue as RepeatState)
              : "off";
            mutation(
              command,
              io,
              "repeat",
              { source: "runtime", repeat: applied, state: runtime.value },
              `Repeat set to ${applied}.`,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        if (value === "cycle")
          mode = nextRepeatState(
            (await player.state("foreground"))?.repeat_state ?? "off",
          );
        else mode = enumValue(REPEAT_MODES, "repeat mode")(value);
        await player.setRepeat(mode, deviceId);
        mutation(
          command,
          io,
          "repeat",
          { repeat: mode, deviceId: deviceId ?? null },
          `Repeat set to ${mode}.`,
        );
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
        const ref = spotifyReference(target);
        if (
          !["track", "episode", "album", "artist", "playlist"].includes(
            ref.kind,
          )
        ) {
          if (ref.kind === "show") {
            throw usageError(
              "Spotify shows cannot be played as a context. Play one of its episodes instead — `spotuify show <show-uri>` lists them.",
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
