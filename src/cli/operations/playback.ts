import { nextRepeatState } from "../../api/player.ts";
import type { RepeatState } from "../../api/types.ts";
import { runtimeRequest, tryRuntimeRequest } from "../../runtime/control.ts";
import { unavailable, usageError } from "../errors.ts";
import {
  formatDuration,
  normalizePlayback,
  normalizeRuntimePlayback,
  playbackText,
} from "../output.ts";
import { cliSession } from "../session.ts";
import {
  activeDeviceTarget,
  currentState,
  resolveDeviceTarget,
  runtimeBoolean,
  runtimeNumber,
  runtimePlaybackText,
} from "../support.ts";
import { spotifyReference, type SpotifyReference } from "../values.ts";
import type { OperationResult } from "./types.ts";

export const REPEAT_MODES: readonly RepeatState[] = ["off", "context", "track"];

const PLAYABLE_KINDS: readonly string[] = [
  "track",
  "episode",
  "album",
  "artist",
  "playlist",
];

export async function playbackStatus(): Promise<
  OperationResult<Record<string, unknown>>
> {
  const runtime = await tryRuntimeRequest("status");
  if (runtime.connected) {
    return {
      data: normalizeRuntimePlayback(runtime.value),
      message: runtimePlaybackText(runtime.value),
    };
  }
  const state = await currentState();
  return { data: normalizePlayback(state), message: playbackText(state) };
}

function assertPlayable(ref: SpotifyReference): void {
  if (ref.kind === "show") {
    throw usageError(
      "Spotify shows cannot be played as a context. Play one of its episodes instead — `spotuify show <show-uri>` lists them.",
    );
  }
  if (!PLAYABLE_KINDS.includes(ref.kind)) {
    throw usageError(`Spotify ${ref.kind} resources cannot be played.`);
  }
}

interface PlayRequest {
  uris?: string[];
  contextUri?: string;
  offset?: number;
}

type PlayOutcome =
  | { via: "local"; deviceId: string; state: unknown }
  | { via: "runtime"; state: unknown }
  | { via: "web"; deviceId: string | undefined };

/**
 * Dispatch a play request along the established route.
 *
 * A selector naming the embedded receiver routes through its runtime: transfer natively when it
 * does not hold the session, then start playback inside the serialized stream. Without a selector
 * an available runtime takes the command; the Web API is the fallback and the only path for a
 * remote device target.
 */
async function routedPlay(
  params: PlayRequest,
  deviceSelector: string | undefined,
): Promise<PlayOutcome> {
  const resolved =
    deviceSelector === undefined
      ? undefined
      : await resolveDeviceTarget(deviceSelector);
  if (resolved?.route === "local") {
    if (!resolved.active) {
      await runtimeRequest("device.transfer", {
        selector: resolved.id,
        play: false,
      });
    }
    const state = await runtimeRequest("play", params);
    return { via: "local", deviceId: resolved.id, state };
  }
  if (resolved === undefined) {
    const runtime = await tryRuntimeRequest("play", params);
    if (runtime.connected) return { via: "runtime", state: runtime.value };
  }
  const { player } = await cliSession();
  const deviceId = resolved?.device.id;
  if (params.uris !== undefined) {
    await player.play({ deviceId, uris: params.uris });
  } else if (params.contextUri !== undefined) {
    await player.play({
      deviceId,
      contextUri: params.contextUri,
      offset: params.offset,
    });
  } else {
    await player.play({ deviceId });
  }
  return { via: "web", deviceId };
}

export async function startPlayback(
  options: { target?: string; device?: string; index?: number } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  const { target } = options;
  const offset = options.index === undefined ? undefined : options.index - 1;
  if (offset !== undefined && target === undefined) {
    throw usageError("--index requires an album or playlist target.");
  }
  const ref = target === undefined ? undefined : spotifyReference(target);
  if (
    ref !== undefined &&
    offset !== undefined &&
    ref.kind !== "album" &&
    ref.kind !== "playlist"
  ) {
    throw usageError("--index is only valid for album or playlist contexts.");
  }
  if (ref !== undefined) assertPlayable(ref);
  const params: PlayRequest =
    ref === undefined
      ? {}
      : ref.kind === "track" || ref.kind === "episode"
        ? { uris: [ref.uri] }
        : { contextUri: ref.uri, offset };
  const message =
    target === undefined ? "Playback resumed." : `Playing ${target}.`;
  const outcome = await routedPlay(params, options.device);
  switch (outcome.via) {
    case "local":
      return {
        data: {
          source: "runtime",
          target: target ?? null,
          deviceId: outcome.deviceId,
          state: outcome.state,
        },
        message,
      };
    case "runtime":
      return {
        data: { source: "runtime", target: target ?? null, state: outcome.state },
        message,
      };
    case "web":
      return {
        data: { target: target ?? null, deviceId: outcome.deviceId ?? null },
        message,
      };
  }
}

export async function openPlayback(options: {
  target: string;
  device?: string;
}): Promise<OperationResult<Record<string, unknown>>> {
  const ref = spotifyReference(options.target);
  assertPlayable(ref);
  const params: PlayRequest =
    ref.kind === "track" || ref.kind === "episode"
      ? { uris: [ref.uri] }
      : { contextUri: ref.uri };
  const message = `Playing ${ref.uri}.`;
  const outcome = await routedPlay(params, options.device);
  switch (outcome.via) {
    case "local":
      return {
        data: {
          source: "runtime",
          uri: ref.uri,
          deviceId: outcome.deviceId,
          state: outcome.state,
        },
        message,
      };
    case "runtime":
      return {
        data: { source: "runtime", uri: ref.uri, state: outcome.state },
        message,
      };
    case "web":
      return {
        data: { uri: ref.uri, deviceId: outcome.deviceId ?? null },
        message,
      };
  }
}

export async function pausePlayback(
  options: { device?: string } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  const resolved = await activeDeviceTarget(options.device);
  if (resolved === undefined || resolved.route === "local") {
    const runtime = await tryRuntimeRequest("pause");
    if (runtime.connected) {
      return {
        data: { source: "runtime", state: runtime.value },
        message: "Playback paused.",
      };
    }
  }
  const { player } = await cliSession();
  const deviceId = resolved?.route === "web" ? resolved.device.id : undefined;
  await player.pause(deviceId);
  return { data: { deviceId: deviceId ?? null }, message: "Playback paused." };
}

export async function togglePlayback(): Promise<
  OperationResult<Record<string, unknown>>
> {
  const runtime = await tryRuntimeRequest("toggle");
  if (runtime.connected) {
    const playing = runtimeBoolean(runtime.value, "isPlaying") === true;
    return {
      data: { source: "runtime", isPlaying: playing, state: runtime.value },
      message: playing ? "Playback resumed." : "Playback paused.",
    };
  }
  const { player } = await cliSession();
  const state = await player.state("foreground");
  if (state?.is_playing === true) await player.pause();
  else await player.play();
  return {
    data: { isPlaying: state?.is_playing !== true },
    message:
      state?.is_playing === true ? "Playback paused." : "Playback resumed.",
  };
}

export async function skip(
  direction: "next" | "previous",
  options: { device?: string } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  const message =
    direction === "next" ? "Skipped to next item." : "Returned to previous item.";
  const resolved = await activeDeviceTarget(options.device);
  if (resolved === undefined || resolved.route === "local") {
    const runtime = await tryRuntimeRequest(direction);
    if (runtime.connected) {
      return { data: { source: "runtime", state: runtime.value }, message };
    }
  }
  const { player } = await cliSession();
  const deviceId = resolved?.route === "web" ? resolved.device.id : undefined;
  await player[direction](deviceId);
  return { data: { deviceId: deviceId ?? null }, message };
}

export async function seekPlayback(options: {
  positionMs?: number;
  offsetMs?: number;
  device?: string;
}): Promise<OperationResult<Record<string, unknown>>> {
  if (options.positionMs !== undefined && options.offsetMs !== undefined) {
    throw usageError("Seek accepts a position or an offset, not both.");
  }
  let relative: boolean;
  let milliseconds: number;
  if (options.offsetMs !== undefined) {
    relative = true;
    milliseconds = options.offsetMs;
  } else if (options.positionMs !== undefined) {
    relative = false;
    milliseconds = options.positionMs;
  } else {
    throw usageError("Seek requires a position or an offset.");
  }
  let target = milliseconds;
  const resolved = await activeDeviceTarget(options.device);
  if (resolved === undefined || resolved.route === "local") {
    // A relative seek is sent as the raw offset: the runtime applies it inside its
    // serialized mutation, so two concurrent `seek +5s` commands both land.
    const runtime = await tryRuntimeRequest(
      "seek",
      relative
        ? { offsetMs: milliseconds }
        : { positionMs: Math.max(0, milliseconds) },
    );
    if (runtime.connected) {
      const position =
        runtimeNumber(runtime.value, "progressMs") ??
        Math.max(0, milliseconds);
      return {
        data: { source: "runtime", positionMs: position, state: runtime.value },
        message: `Seeked to ${formatDuration(position)}.`,
      };
    }
  }
  const { player } = await cliSession();
  const deviceId = resolved?.route === "web" ? resolved.device.id : undefined;
  if (relative) {
    const state = await player.state("foreground");
    if (state === null) throw unavailable("Nothing is playing.");
    if (state.progress_ms === null) {
      throw unavailable("The current playback position is unavailable.");
    }
    target += state.progress_ms;
  }
  target = Math.max(0, target);
  await player.seek(target, deviceId);
  return {
    data: { positionMs: target, deviceId: deviceId ?? null },
    message: `Seeked to ${formatDuration(target)}.`,
  };
}

export async function setVolume(options: {
  percent?: number;
  delta?: number;
  device?: string;
}): Promise<OperationResult<Record<string, unknown>>> {
  if (options.percent !== undefined && options.delta !== undefined) {
    throw usageError("Volume accepts a level or a delta, not both.");
  }
  let relative: boolean;
  let percent: number;
  if (options.delta !== undefined) {
    relative = true;
    percent = options.delta;
  } else if (options.percent !== undefined) {
    relative = false;
    percent = options.percent;
  } else {
    throw usageError("Volume requires a level or a delta.");
  }
  if (!relative && (percent < 0 || percent > 100)) {
    throw usageError("Volume must be between 0 and 100.");
  }
  const resolved = await activeDeviceTarget(options.device);
  if (resolved === undefined || resolved.route === "local") {
    // A relative change is sent as the raw delta and applied inside the runtime's
    // serialized mutation, so two concurrent `volume +5` commands both land.
    const runtime = await tryRuntimeRequest(
      "volume",
      relative
        ? { delta: Math.round(percent) }
        : { percent: Math.round(percent) },
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
      return {
        data: {
          source: "runtime",
          volumePercent: typeof volume === "number" ? volume : null,
          state: runtime.value,
        },
        message:
          typeof volume === "number"
            ? `Volume set to ${volume}%.`
            : "Volume adjusted.",
      };
    }
  }
  const { player } = await cliSession();
  const device = resolved?.route === "web" ? resolved.device : undefined;
  if (relative) {
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
  return {
    data: { volumePercent: percent, deviceId: device?.id ?? null },
    message: `Volume set to ${percent}%.`,
  };
}

export async function setShuffle(
  state: boolean | "toggle",
  options: { device?: string } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  const resolved = await activeDeviceTarget(options.device);
  if (resolved === undefined || resolved.route === "local") {
    // `toggle` is sent as the toggle itself so the runtime flips its own serialized state;
    // resolving it here from a status read would race a concurrent toggle.
    const runtime = await tryRuntimeRequest(
      "shuffle",
      state === "toggle" ? { toggle: true } : { enabled: state },
    );
    if (runtime.connected) {
      const enabled = runtimeBoolean(runtime.value, "shuffle") ?? false;
      return {
        data: { source: "runtime", shuffle: enabled, state: runtime.value },
        message: `Shuffle ${enabled ? "on" : "off"}.`,
      };
    }
  }
  const { player } = await cliSession();
  const deviceId = resolved?.route === "web" ? resolved.device.id : undefined;
  const enabled =
    state === "toggle"
      ? !(await player.state("foreground"))?.shuffle_state
      : state;
  await player.setShuffle(enabled, deviceId);
  return {
    data: { shuffle: enabled, deviceId: deviceId ?? null },
    message: `Shuffle ${enabled ? "on" : "off"}.`,
  };
}

export async function setRepeat(
  mode: RepeatState | "cycle",
  options: { device?: string } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  const resolved = await activeDeviceTarget(options.device);
  if (resolved === undefined || resolved.route === "local") {
    // `cycle` is sent as the cycle itself so the runtime advances its own serialized state;
    // resolving it here from a status read would race a concurrent cycle.
    const runtime = await tryRuntimeRequest("repeat", { mode });
    if (runtime.connected) {
      const stateValue =
        runtime.value !== null && typeof runtime.value === "object"
          ? (runtime.value as Record<string, unknown>)["repeat"]
          : "off";
      const applied = REPEAT_MODES.includes(stateValue as RepeatState)
        ? (stateValue as RepeatState)
        : "off";
      return {
        data: { source: "runtime", repeat: applied, state: runtime.value },
        message: `Repeat set to ${applied}.`,
      };
    }
  }
  const { player } = await cliSession();
  const deviceId = resolved?.route === "web" ? resolved.device.id : undefined;
  const applied =
    mode === "cycle"
      ? nextRepeatState((await player.state("foreground"))?.repeat_state ?? "off")
      : mode;
  await player.setRepeat(applied, deviceId);
  return {
    data: { repeat: applied, deviceId: deviceId ?? null },
    message: `Repeat set to ${applied}.`,
  };
}
