import { SpotifyClient } from "../api/client.ts";
import { PlayerApi } from "../api/player.ts";
import { tokenStore } from "../auth/flow.ts";
import { resolveBootProfile } from "../auth/profile.ts";
import { LibrespotEngine } from "../engine/librespot.ts";
import { usePlayback } from "../store/playback.ts";
import {
  RuntimeAlreadyRunningError,
  startControlServer,
  tryRuntimeRequest,
} from "./control.ts";
import { createPlaybackRuntimeHandler } from "./playback-control.ts";

/**
 * Run the shared playback runtime without a renderer.
 *
 * This is deliberately foreground-only. Process supervision, restart policy, logs, and startup
 * ordering belong to launchd/systemd/Task Scheduler rather than an ad-hoc daemonizer hidden inside
 * the CLI.
 */
export async function runHeadlessRuntime(onReady?: () => void): Promise<void> {
  if ((await tryRuntimeRequest("ping")).connected)
    throw new RuntimeAlreadyRunningError();
  const tokens = await tokenStore();
  const client = new SpotifyClient(tokens);
  const authorizationId = await tokens.authorizationId();
  const { profile } = await resolveBootProfile(client, authorizationId);
  if (profile === null)
    throw new Error("Spotify account details are temporarily unavailable.");

  const player = new PlayerApi(client);
  const engine = new LibrespotEngine();
  let requestStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
  });
  const playbackHandler = createPlaybackRuntimeHandler(player);
  const server = await startControlServer(
    async (method, params) => {
      if (method === "shutdown") {
        queueMicrotask(() => requestStop?.());
        return { stopping: true };
      }
      return await playbackHandler(method, params);
    },
    { kind: "service", publish: false },
  );
  let stopPlayback: (() => void) | undefined;
  try {
    await engine.start();
    stopPlayback = usePlayback.getState().start(player, engine, profile.id);
    await server.publish();
  } catch (error) {
    await server.close();
    stopPlayback?.();
    engine.stop();
    throw error;
  }

  const signalStop = () => requestStop?.();
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  onReady?.();
  try {
    await stopped;
  } finally {
    process.off("SIGINT", signalStop);
    process.off("SIGTERM", signalStop);
    await server.close();
    stopPlayback?.();
    engine.stop();
  }
}
