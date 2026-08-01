import { afterEach, describe, expect, test } from "bun:test";
import type { PlayerApi } from "../src/api/player.ts";
import {
  createPlaybackRuntimeHandler,
  playbackRuntimeSnapshot,
} from "../src/runtime/playback-control.ts";
import { usePlayback } from "../src/store/playback.ts";

const defaultTogglePlay = usePlayback.getState().togglePlay;

afterEach(() => {
  usePlayback.setState({
    deviceId: null,
    deviceName: null,
    contextUri: null,
    sessionPresence: "unknown",
    isPlaying: false,
    ready: false,
    togglePlay: defaultTogglePlay,
  });
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
});
