import type { PlayerApi } from "../api/player.ts";
import {
  artistLine,
  isTrack,
  type PlayableItem,
  type RepeatState,
} from "../api/types.ts";
import { usePlayback } from "../store/playback.ts";
import { asCliError, unavailable, usageError } from "../cli/errors.ts";
import {
  startControlServer,
  type ControlServer,
  type RuntimeHandler,
} from "./control.ts";

function itemValue(item: PlayableItem | null): Record<string, unknown> | null {
  if (item === null) return null;
  return {
    type: isTrack(item) ? "track" : "episode",
    id: item.id,
    uri: item.uri,
    name: item.name,
    artists: isTrack(item) ? item.artists.map((artist) => artist.name) : [],
    artist: artistLine(item),
    album: isTrack(item) ? item.album.name : null,
    show: isTrack(item) ? null : (item.show?.name ?? null),
    durationMs: item.duration_ms,
  };
}

export function playbackRuntimeSnapshot(): Record<string, unknown> {
  const state = usePlayback.getState();
  return {
    source: "runtime",
    active: state.sessionPresence === "present",
    ready: state.ready,
    isPlaying: state.isPlaying,
    item: itemValue(state.item),
    progressMs: state.progressMs,
    durationMs: state.durationMs,
    shuffle: state.shuffle,
    repeat: state.repeat,
    contextUri: state.contextUri,
    device:
      state.deviceId === null && state.deviceName === null
        ? null
        : {
            id: state.deviceId,
            name: state.deviceName,
            volumePercent: state.volumePercent,
          },
    error: state.error,
  };
}

function objectParams(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params))
    throw usageError("Invalid runtime parameters.");
  return params as Record<string, unknown>;
}

export function createPlaybackRuntimeHandler(
  player?: PlayerApi,
): RuntimeHandler {
  let mutationTail: Promise<void> = Promise.resolve();
  const handler: RuntimeHandler = async (method, rawParams) => {
    const store = usePlayback.getState();
    const params = objectParams(rawParams ?? {});
    if (method !== "status" && !store.ready) {
      throw unavailable(
        "Playback state is still loading.",
        "Wait a moment and retry the command.",
      );
    }
    switch (method) {
      case "status":
        return playbackRuntimeSnapshot();
      case "play": {
        const contextUri =
          typeof params["contextUri"] === "string"
            ? params["contextUri"]
            : undefined;
        const uris =
          Array.isArray(params["uris"]) &&
          params["uris"].every((uri) => typeof uri === "string")
            ? (params["uris"] as string[])
            : undefined;
        const offset =
          typeof params["offset"] === "number" ? params["offset"] : undefined;
        if (contextUri !== undefined || uris !== undefined)
          await store.playSelection({ contextUri, uris, offset });
        else if (!store.isPlaying) await store.togglePlay();
        break;
      }
      case "pause":
        if (store.isPlaying) await store.togglePlay();
        break;
      case "toggle":
        await store.togglePlay();
        break;
      case "next":
        await store.next();
        break;
      case "previous":
        await store.previous();
        break;
      case "seek": {
        if (typeof params["positionMs"] !== "number")
          throw usageError("positionMs is required.");
        await store.seekBy(params["positionMs"] - store.progressMs);
        break;
      }
      case "volume": {
        if (typeof params["percent"] !== "number")
          throw usageError("percent is required.");
        if (store.volumePercent === null)
          throw unavailable("The active device does not report its volume.");
        await store.adjustVolume(params["percent"] - store.volumePercent);
        break;
      }
      case "shuffle": {
        if (typeof params["enabled"] !== "boolean")
          throw usageError("enabled is required.");
        if (store.shuffle !== params["enabled"]) await store.toggleShuffle();
        break;
      }
      case "repeat": {
        if (
          !(["off", "context", "track"] as unknown[]).includes(params["mode"])
        )
          throw usageError("mode is required.");
        const target = params["mode"] as RepeatState;
        for (
          let count = 0;
          count < 2 && usePlayback.getState().repeat !== target;
          count++
        ) {
          await usePlayback.getState().cycleRepeat();
        }
        break;
      }
      case "device.transfer": {
        if (player === undefined)
          throw unavailable("Device transfer is unavailable.");
        if (typeof params["selector"] !== "string")
          throw usageError("selector is required.");
        const devices = await player.devices();
        const byId = devices.find((device) => device.id === params["selector"]);
        const named = devices.filter(
          (device) =>
            device.name.toLowerCase() ===
            String(params["selector"]).toLowerCase(),
        );
        const device = byId ?? (named.length === 1 ? named[0] : undefined);
        if (device === undefined) {
          if (named.length > 1)
            throw usageError(
              "More than one device has that name; use its ID.",
            );
          throw unavailable("Spotify device not found.");
        }
        if (device.id === null || device.is_restricted) {
          throw unavailable("That device cannot receive playback.");
        }
        const play = params["play"] !== false;
        await player.transfer(device.id, play);
        store.confirmDeviceTransfer(device.id, device.name);
        return { device, play, state: playbackRuntimeSnapshot() };
      }
      default:
        throw usageError(`Unknown runtime method: ${method}`);
    }
    return playbackRuntimeSnapshot();
  };
  const run = async (method: string, params: unknown) => {
    try {
      return await handler(method, params);
    } catch (error) {
      throw asCliError(error);
    }
  };
  return (method, params) => {
    if (method === "status") return run(method, params);
    const result = mutationTail.then(
      () => run(method, params),
      () => run(method, params),
    );
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export const playbackRuntimeHandler = createPlaybackRuntimeHandler();

/** Start the private local command endpoint. A second runtime is rejected without disturbing it. */
export async function startPlaybackControlServer(
  player?: PlayerApi,
  options: { publish?: boolean } = {},
): Promise<ControlServer> {
  return await startControlServer(createPlaybackRuntimeHandler(player), {
    kind: "tui",
    publish: options.publish,
  });
}
