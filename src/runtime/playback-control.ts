import type { PlayerApi } from "../api/player.ts";
import {
  artistLine,
  isTrack,
  type PlayableItem,
  type RepeatState,
} from "../api/types.ts";
import {
  localReceiverId,
  transferPlayback,
  withLocalDevice,
} from "../store/devices.ts";
import {
  usePlayback,
  type PlaybackCommandOutcome,
} from "../store/playback.ts";
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

/** Reject the RPC when a store mutation reports failure; the TUI banner already has the error. */
function accepted(outcome: PlaybackCommandOutcome): void {
  if (outcome !== null) throw outcome.failure;
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
          accepted(await store.playSelection({ contextUri, uris, offset }));
        else if (!store.isPlaying) accepted(await store.togglePlay());
        break;
      }
      case "pause":
        if (store.isPlaying) accepted(await store.togglePlay());
        break;
      case "toggle":
        accepted(await store.togglePlay());
        break;
      case "next":
        accepted(await store.next());
        break;
      case "previous":
        accepted(await store.previous());
        break;
      // Relative forms (`offsetMs`, `delta`, `toggle`, `"cycle"`) exist so clients never have to
      // read state and send back an absolute: that read-modify-write loses updates when two
      // commands race. The delta is applied here, inside the serialized mutation, against state
      // that cannot go stale.
      case "seek": {
        const positionMs = params["positionMs"];
        const offsetMs = params["offsetMs"];
        if (typeof positionMs === "number" && typeof offsetMs === "number")
          throw usageError("Provide positionMs or offsetMs, not both.");
        if (store.item === null) throw unavailable("Nothing is playing.");
        if (typeof offsetMs === "number") accepted(await store.seekBy(offsetMs));
        else if (typeof positionMs === "number")
          accepted(await store.seekBy(positionMs - store.progressMs));
        else throw usageError("positionMs or offsetMs is required.");
        break;
      }
      case "volume": {
        const percent = params["percent"];
        const delta = params["delta"];
        if (typeof percent === "number" && typeof delta === "number")
          throw usageError("Provide percent or delta, not both.");
        if (store.volumePercent === null)
          throw unavailable("The active device does not report its volume.");
        if (typeof delta === "number") accepted(await store.adjustVolume(delta));
        else if (typeof percent === "number")
          accepted(await store.adjustVolume(percent - store.volumePercent));
        else throw usageError("percent or delta is required.");
        break;
      }
      case "shuffle": {
        if (params["toggle"] === true) {
          accepted(await store.toggleShuffle());
          break;
        }
        if (typeof params["enabled"] !== "boolean")
          throw usageError("enabled or toggle is required.");
        if (store.shuffle !== params["enabled"])
          accepted(await store.toggleShuffle());
        break;
      }
      case "repeat": {
        if (params["mode"] === "cycle") {
          accepted(await store.cycleRepeat());
          break;
        }
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
          accepted(await usePlayback.getState().cycleRepeat());
        }
        break;
      }
      case "queue.add": {
        if (player === undefined) throw unavailable("Queue is unavailable.");
        if (typeof params["uri"] !== "string")
          throw usageError("uri is required.");
        // Forwarded through this runtime's own client so a CLI process never spins up a second
        // Web API session, and additions serialize with the other mutations.
        await player.addToQueue(params["uri"]);
        break;
      }
      case "device.list": {
        if (player === undefined)
          throw unavailable("Device listing is unavailable.");
        // The merged view is the runtime's authority: Spotify's list plus the embedded receiver,
        // which `/me/player/devices` does not always include. `localDeviceId` lets clients route
        // receiver-targeted commands through this runtime instead of the Web API.
        return {
          devices: withLocalDevice(await player.devices()),
          localDeviceId: localReceiverId(),
        };
      }
      case "device.transfer": {
        if (player === undefined)
          throw unavailable("Device transfer is unavailable.");
        if (typeof params["selector"] !== "string")
          throw usageError("selector is required.");
        const devices = withLocalDevice(await player.devices());
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
        await transferPlayback(device as typeof device & { id: string }, play, player);
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
    // Metadata reads run concurrently; only stateful commands join the serialized mutation tail.
    if (method === "status" || method === "device.list") return run(method, params);
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
