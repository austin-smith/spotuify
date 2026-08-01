import { afterEach, describe, expect, test } from "bun:test";
import type { PlayerApi } from "../src/api/player.ts";
import type { LibrespotEngine } from "../src/engine/librespot.ts";
import type { Track } from "../src/api/types.ts";
import {
  createPlaybackRuntimeHandler,
  playbackRuntimeSnapshot,
} from "../src/runtime/playback-control.ts";
import { useDevices } from "../src/store/devices.ts";
import { usePlayback } from "../src/store/playback.ts";

const defaults = {
  togglePlay: usePlayback.getState().togglePlay,
  seekBy: usePlayback.getState().seekBy,
  adjustVolume: usePlayback.getState().adjustVolume,
  toggleShuffle: usePlayback.getState().toggleShuffle,
  cycleRepeat: usePlayback.getState().cycleRepeat,
};

const playingTrack: Track = {
  id: "t",
  name: "Song",
  uri: "spotify:track:t",
  duration_ms: 180_000,
  artists: [],
  album: { id: "a", name: "Album", uri: "spotify:album:a", images: [] },
};

afterEach(() => {
  usePlayback.setState({
    deviceId: null,
    deviceName: null,
    contextUri: null,
    sessionPresence: "unknown",
    isPlaying: false,
    ready: false,
    item: null,
    progressMs: 0,
    volumePercent: null,
    shuffle: false,
    ...defaults,
  });
  // A fresh player identity makes the devices module drop its engine/account wiring.
  useDevices.getState().configure({} as PlayerApi, null, null);
});

describe("runtime playback adapter", () => {
  test("includes the authoritative playback context in status snapshots", () => {
    usePlayback.setState({
      contextUri: "spotify:playlist:mix",
      sessionPresence: "present",
    });

    expect(playbackRuntimeSnapshot()).toMatchObject({
      contextUri: "spotify:playlist:mix",
    });
  });

  test("serializes concurrent absolute playback mutations", async () => {
    let toggles = 0;
    usePlayback.setState({
      isPlaying: true,
      ready: true,
      togglePlay: async () => {
        const target = !usePlayback.getState().isPlaying;
        toggles++;
        await Bun.sleep(10);
        usePlayback.setState({ isPlaying: target });
      },
    });
    const handler = createPlaybackRuntimeHandler();

    await Promise.all([handler("pause", {}), handler("pause", {})]);

    expect(toggles).toBe(1);
    expect(usePlayback.getState().isPlaying).toBe(false);
  });

  test("rejects mutations until playback state is initialized", async () => {
    usePlayback.setState({ ready: false });

    await expect(createPlaybackRuntimeHandler()("pause", {})).rejects.toThrow(
      "still loading",
    );
  });

  test("confirms a CLI device transfer in the authoritative playback store", async () => {
    const transfers: { id: string; play: boolean }[] = [];
    const player = {
      devices: async () => [
        {
          id: "living-room",
          name: "Living Room",
          type: "Speaker",
          is_active: false,
          is_restricted: false,
          volume_percent: 35,
        },
      ],
      transfer: async (id: string, play: boolean) => {
        transfers.push({ id, play });
      },
    } as unknown as PlayerApi;
    usePlayback.setState({ ready: true });

    const result = (await createPlaybackRuntimeHandler(player)(
      "device.transfer",
      {
        selector: "Living Room",
        play: false,
      },
    )) as { device: { id: string }; play: boolean };

    expect(transfers).toEqual([{ id: "living-room", play: false }]);
    expect(result).toMatchObject({
      device: { id: "living-room" },
      play: false,
    });
    expect(usePlayback.getState()).toMatchObject({
      deviceId: "living-room",
      deviceName: "Living Room",
      sessionPresence: "present",
    });
  });

  test("requires an ID when device names are ambiguous", async () => {
    const player = {
      devices: async () => [
        { id: "one", name: "Speaker", is_restricted: false },
        { id: "two", name: "Speaker", is_restricted: false },
      ],
    } as unknown as PlayerApi;
    usePlayback.setState({ ready: true });
    await expect(
      createPlaybackRuntimeHandler(player)("device.transfer", {
        selector: "Speaker",
      }),
    ).rejects.toThrow("More than one device");
  });

  /**
   * The regression the relative protocol exists to prevent: two concurrent relative commands must
   * both land. With client-computed absolutes they collapse into one.
   */
  test("applies concurrent relative volume changes cumulatively", async () => {
    usePlayback.setState({
      ready: true,
      volumePercent: 50,
      adjustVolume: async (delta: number) => {
        const current = usePlayback.getState().volumePercent ?? 0;
        await Bun.sleep(10);
        usePlayback.setState({ volumePercent: current + delta });
      },
    });
    const handler = createPlaybackRuntimeHandler();

    await Promise.all([
      handler("volume", { delta: 5 }),
      handler("volume", { delta: 5 }),
    ]);

    expect(usePlayback.getState().volumePercent).toBe(60);
  });

  test("seeks by a raw offset and still accepts absolutes", async () => {
    const seeks: number[] = [];
    usePlayback.setState({
      ready: true,
      item: playingTrack,
      progressMs: 30_000,
      seekBy: async (deltaMs: number) => {
        seeks.push(deltaMs);
      },
    });
    const handler = createPlaybackRuntimeHandler();

    await handler("seek", { offsetMs: -15_000 });
    await handler("seek", { positionMs: 60_000 });

    expect(seeks).toEqual([-15_000, 30_000]);
  });

  test("rejects a seek when nothing is playing", async () => {
    usePlayback.setState({ ready: true, item: null });
    await expect(
      createPlaybackRuntimeHandler()("seek", { offsetMs: 5_000 }),
    ).rejects.toThrow("Nothing is playing");
  });

  test("resolves shuffle toggle and repeat cycle inside the serialized mutation", async () => {
    let shuffles = 0;
    let cycles = 0;
    usePlayback.setState({
      ready: true,
      toggleShuffle: async () => {
        shuffles++;
      },
      cycleRepeat: async () => {
        cycles++;
      },
    });
    const handler = createPlaybackRuntimeHandler();

    await Promise.all([
      handler("shuffle", { toggle: true }),
      handler("shuffle", { toggle: true }),
    ]);
    await handler("repeat", { mode: "cycle" });

    expect(shuffles).toBe(2);
    expect(cycles).toBe(1);
  });

  test("rejects ambiguous relative-and-absolute parameters", async () => {
    usePlayback.setState({ ready: true, item: playingTrack, volumePercent: 50 });
    const handler = createPlaybackRuntimeHandler();
    await expect(
      handler("volume", { percent: 40, delta: 5 }),
    ).rejects.toThrow("not both");
    await expect(
      handler("seek", { positionMs: 1_000, offsetMs: 1_000 }),
    ).rejects.toThrow("not both");
  });

  test("lists the merged device view with the receiver identified", async () => {
    const player = {
      devices: async () => [
        {
          id: "remote",
          name: "Living Room",
          type: "Speaker",
          is_active: false,
          is_restricted: false,
          volume_percent: 35,
        },
      ],
    } as unknown as PlayerApi;
    const engine = {
      getStatus: () => ({
        state: "ready",
        accountId: "acct",
        deviceId: "local-dev",
      }),
      isActive: () => true,
    } as unknown as LibrespotEngine;
    useDevices.getState().configure(player, engine, "acct");
    usePlayback.setState({ ready: true, deviceId: "local-dev" });

    const result = (await createPlaybackRuntimeHandler(player)(
      "device.list",
      {},
    )) as { devices: { id: string | null }[]; localDeviceId: string | null };

    expect(result.localDeviceId).toBe("local-dev");
    expect(result.devices.map((device) => device.id)).toEqual([
      "local-dev",
      "remote",
    ]);
  });

  test("routes a transfer to the embedded receiver through librespot", async () => {
    const engineTransfers: number[] = [];
    const webTransfers: { id: string; play: boolean }[] = [];
    const player = {
      devices: async () => [],
      transfer: async (id: string, play: boolean) => {
        webTransfers.push({ id, play });
      },
    } as unknown as PlayerApi;
    const engine = {
      getStatus: () => ({
        state: "ready",
        accountId: "acct",
        deviceId: "local-dev",
      }),
      isActive: () => true,
      transfer: async () => {
        engineTransfers.push(1);
      },
    } as unknown as LibrespotEngine;
    useDevices.getState().configure(player, engine, "acct");
    usePlayback.setState({ ready: true, isPlaying: true });

    const result = (await createPlaybackRuntimeHandler(player)(
      "device.transfer",
      { selector: "local-dev" },
    )) as { device: { id: string } };

    expect(result.device.id).toBe("local-dev");
    expect(engineTransfers).toHaveLength(1);
    // The Web API path must not run: it would mark our own receiver as an external transfer.
    expect(webTransfers).toEqual([]);
    expect(usePlayback.getState().deviceId).toBeNull();
  });

  test("keeps Web API routing when the receiver account does not match", async () => {
    const engineTransfers: number[] = [];
    const webTransfers: { id: string; play: boolean }[] = [];
    const player = {
      devices: async () => [
        {
          id: "local-dev",
          name: "spotuify",
          type: "Computer",
          is_active: false,
          is_restricted: false,
          volume_percent: 50,
        },
      ],
      transfer: async (id: string, play: boolean) => {
        webTransfers.push({ id, play });
      },
    } as unknown as PlayerApi;
    const engine = {
      getStatus: () => ({
        state: "ready",
        accountId: "someone-else",
        deviceId: "local-dev",
      }),
      isActive: () => true,
      transfer: async () => {
        engineTransfers.push(1);
      },
    } as unknown as LibrespotEngine;
    useDevices.getState().configure(player, engine, "acct");
    usePlayback.setState({ ready: true });

    await createPlaybackRuntimeHandler(player)("device.transfer", {
      selector: "local-dev",
      play: false,
    });

    expect(engineTransfers).toEqual([]);
    expect(webTransfers).toEqual([{ id: "local-dev", play: false }]);
    expect(usePlayback.getState().deviceId).toBe("local-dev");
  });
});
