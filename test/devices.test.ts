import { afterEach, describe, expect, test } from "bun:test";
import type { PlayerApi } from "../src/api/player.ts";
import type { LibrespotEngine } from "../src/engine/librespot.ts";
import { useDevices } from "../src/store/devices.ts";
import { usePlayback } from "../src/store/playback.ts";

afterEach(() => {
  useDevices.getState().closePicker();
  usePlayback.setState({ deviceId: null, deviceName: null });
});

describe("native device integration", () => {
  test("the local receiver remains selectable when Spotify omits or refuses the device list", async () => {
    let transfers = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native-id", accountId: "account" }) as const,
      transfer: async () => {
        transfers++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      devices: async () => {
        throw new Error("quota exhausted");
      },
      transfer: async () => {
        throw new Error("the Web API must not transfer the native receiver");
      },
    } as unknown as PlayerApi;

    useDevices.getState().configure(player, engine, "account");
    useDevices.getState().openPicker();
    await Bun.sleep(20);

    expect(useDevices.getState().devices.map((device) => device.id)).toEqual(["native-id"]);
    expect(useDevices.getState().error).toBeNull();
    await useDevices.getState().activate();
    expect(transfers).toBe(1);
  });

  test("a device-list response cannot duplicate the locally known receiver", async () => {
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native-id", accountId: "account" }) as const,
    } as unknown as LibrespotEngine;
    const player = {
      devices: async () => [
        {
          id: "native-id",
          name: "spotuify",
          type: "Computer",
          is_active: false,
          is_restricted: false,
          volume_percent: 100,
        },
        {
          id: "speaker",
          name: "Living Room",
          type: "Speaker",
          is_active: true,
          is_restricted: false,
          volume_percent: 30,
        },
      ],
    } as unknown as PlayerApi;

    useDevices.getState().configure(player, engine, "account");
    useDevices.getState().openPicker();
    await Bun.sleep(20);

    expect(useDevices.getState().devices.map((device) => device.id)).toEqual([
      "native-id",
      "speaker",
    ]);
  });

  test("a different receiver with the same display name remains selectable", async () => {
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native-id", accountId: "account" }) as const,
    } as unknown as LibrespotEngine;
    const player = {
      devices: async () => [
        {
          id: "other-id",
          name: "spotuify",
          type: "Computer",
          is_active: true,
          is_restricted: false,
          volume_percent: 40,
        },
      ],
    } as unknown as PlayerApi;

    useDevices.getState().configure(player, engine, "account");
    useDevices.getState().openPicker();
    await Bun.sleep(20);

    expect(useDevices.getState().devices.map((device) => device.id)).toEqual([
      "native-id",
      "other-id",
    ]);
    expect(useDevices.getState().devices[0]?.is_active).toBe(false);
    expect(useDevices.getState().devices[1]?.is_active).toBe(true);
  });

  test("a receiver cached for another account is not synthesized or transferred", async () => {
    let nativeTransfers = 0;
    const engine = {
      getStatus: () =>
        ({
          state: "ready",
          pid: 1,
          deviceId: "native-id",
          accountId: "other-account",
        }) as const,
      transfer: async () => {
        nativeTransfers++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      devices: async () => [
        {
          id: "speaker",
          name: "Living Room",
          type: "Speaker",
          is_active: true,
          is_restricted: false,
          volume_percent: 30,
        },
      ],
      transfer: async () => {},
    } as unknown as PlayerApi;

    useDevices.getState().configure(player, engine, "account");
    useDevices.getState().openPicker();
    await Bun.sleep(20);

    expect(useDevices.getState().devices.map((device) => device.id)).toEqual(["speaker"]);
    await useDevices.getState().activate();
    expect(nativeTransfers).toBe(0);
  });

  test("a stale native device id cannot mark a disconnected receiver active", async () => {
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native-id", accountId: "account" }) as const,
      isActive: () => false,
    } as unknown as LibrespotEngine;
    const player = {
      devices: async () => [
        {
          id: "speaker",
          name: "Living Room",
          type: "Speaker",
          is_active: true,
          is_restricted: false,
          volume_percent: 30,
        },
      ],
    } as unknown as PlayerApi;
    usePlayback.setState({ deviceId: "native-id", deviceName: "spotuify" });

    useDevices.getState().configure(player, engine, "account");
    useDevices.getState().openPicker();
    await Bun.sleep(20);

    expect(useDevices.getState().devices[0]).toMatchObject({
      id: "native-id",
      is_active: false,
    });
    expect(useDevices.getState().current()?.id).toBe("speaker");
  });

  test("reopening the picker reuses a recent successful device list", async () => {
    let reads = 0;
    const player = {
      devices: async () => {
        reads++;
        return [
          {
            id: "speaker",
            name: "Living Room",
            type: "Speaker",
            is_active: true,
            is_restricted: false,
            volume_percent: 30,
          },
        ];
      },
    } as unknown as PlayerApi;

    useDevices.getState().configure(player, null);
    useDevices.getState().openPicker();
    await Bun.sleep(20);
    useDevices.getState().closePicker();
    useDevices.getState().openPicker();

    expect(reads).toBe(1);
    expect(useDevices.getState().loading).toBe(false);
    expect(useDevices.getState().devices.map((device) => device.id)).toEqual(["speaker"]);
  });

  test("changing clients cannot attach an old device response to the new account", async () => {
    let releaseOld: ((devices: never[]) => void) | undefined;
    const oldPending = new Promise<never[]>((resolve) => {
      releaseOld = resolve;
    });
    const oldPlayer = {
      devices: async () => await oldPending,
    } as unknown as PlayerApi;
    const newPlayer = {
      devices: async () => [
        {
          id: "new-speaker",
          name: "New Speaker",
          type: "Speaker",
          is_active: true,
          is_restricted: false,
          volume_percent: 40,
        },
      ],
    } as unknown as PlayerApi;

    useDevices.getState().configure(oldPlayer, null);
    useDevices.getState().openPicker();
    useDevices.getState().configure(newPlayer, null);
    useDevices.getState().openPicker();
    await Bun.sleep(20);
    releaseOld?.([]);
    await Bun.sleep(5);

    expect(useDevices.getState().devices.map((device) => device.id)).toEqual(["new-speaker"]);
  });

  test("a successful remote transfer immediately owns subsequent command routing", async () => {
    const calls: string[] = [];
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native-id", accountId: "account" }) as const,
      onEvent: () => () => {},
      activate: async () => calls.push("native-activate"),
      load: async () => calls.push("native-load"),
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => null,
      devices: async () => [
        {
          id: "speaker",
          name: "Living Room",
          type: "Speaker",
          is_active: false,
          is_restricted: false,
          volume_percent: 30,
        },
      ],
      transfer: async (deviceId: string) => calls.push(`transfer:${deviceId}`),
      play: async ({ deviceId }: { deviceId?: string }) => calls.push(`play:${deviceId}`),
    } as unknown as PlayerApi;

    const stopPlayback = usePlayback.getState().start(player, engine, "account");
    try {
      await Bun.sleep(20);
      useDevices.getState().configure(player, engine, "account");
      useDevices.getState().openPicker();
      await Bun.sleep(20);
      useDevices.getState().move(1);
      await useDevices.getState().activate();

      expect(usePlayback.getState().deviceId).toBe("speaker");
      expect(usePlayback.getState().sessionPresence).toBe("present");

      await usePlayback.getState().playSelection({ uris: ["spotify:track:track"] });
      expect(calls).toEqual(["transfer:speaker", "play:speaker"]);
    } finally {
      stopPlayback();
    }
  });
});
