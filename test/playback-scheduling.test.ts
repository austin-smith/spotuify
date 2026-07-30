import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlayerApi } from "../src/api/player.ts";
import { isTrack, type PlaybackState } from "../src/api/types.ts";
import {
  type EngineEvent,
  type LibrespotEngine,
  NativePlaybackUnavailableError,
} from "../src/engine/librespot.ts";
import { chooseImage } from "../src/ui/art.ts";
import {
  COMMAND_RECONCILE_MS,
  ERROR_LINGER_MS,
  usePlayback,
} from "../src/store/playback.ts";

const REMOTE_STATE: PlaybackState = {
  item: {
    id: "track",
    name: "Track",
    uri: "spotify:track:track",
    duration_ms: 180_000,
    artists: [{ id: "artist", name: "Artist", uri: "spotify:artist:artist" }],
    album: { id: "album", name: "Album", uri: "spotify:album:album", images: [] },
  },
  is_playing: true,
  progress_ms: 1_000,
  shuffle_state: false,
  repeat_state: "off",
  context: null,
  currently_playing_type: "track",
  device: {
    id: "remote",
    name: "Living Room",
    type: "Speaker",
    is_active: true,
    is_restricted: false,
    volume_percent: 50,
  },
};

let stop: (() => void) | undefined;

beforeEach(() => {
  usePlayback.setState({
    item: null,
    isPlaying: false,
    progressMs: 0,
    durationMs: 0,
    deviceId: null,
    deviceName: null,
    sessionPresence: "unknown",
    error: null,
    ready: false,
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("playback request budget", () => {
  test("a coordinated account probe can suspend and resume Web reconciliation", async () => {
    let reads = 0;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback
      .getState()
      .start(player, undefined, "account", { suspendWebReconciliation: true });
    await Bun.sleep(20);

    expect(reads).toBe(0);
    expect(usePlayback.getState().ready).toBeTrue();
    expect(usePlayback.getState().item).toBeNull();
    expect(usePlayback.getState().deviceId).toBeNull();
    await usePlayback.getState().refresh();
    expect(reads).toBe(0);

    await usePlayback.getState().resumeWebReconciliation();
    expect(reads).toBe(1);
    expect(usePlayback.getState().deviceId).toBe("remote");
  });

  test("suspending for a manual account probe cancels an in-flight playback read", async () => {
    let reads = 0;
    let firstReadAborted = false;
    const player = {
      state: async (
        _priority: "foreground" | "background",
        signal?: AbortSignal,
      ) => {
        reads++;
        if (reads > 1) return REMOTE_STATE;
        return await new Promise<PlaybackState>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              firstReadAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, undefined, "account");
    await Bun.sleep(1);
    usePlayback.getState().suspendWebReconciliation();
    await Bun.sleep(1);

    expect(firstReadAborted).toBeTrue();
    await usePlayback.getState().refresh();
    expect(reads).toBe(1);

    await usePlayback.getState().resumeWebReconciliation();
    expect(reads).toBe(2);
    expect(usePlayback.getState().deviceId).toBe("remote");
  });

  test("a playback object with no item preserves its active device", async () => {
    const stateWithoutItem: PlaybackState = {
      ...REMOTE_STATE,
      item: null,
      currently_playing_type: "ad",
    };
    const player = {
      state: async () => stateWithoutItem,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(20);

    expect(usePlayback.getState().item).toBeNull();
    expect(usePlayback.getState().deviceId).toBe("remote");
    expect(usePlayback.getState().deviceName).toBe("Living Room");
    expect(usePlayback.getState().sessionPresence).toBe("present");
  });

  test("only a 204 response marks the playback session absent", async () => {
    const player = {
      state: async () => null,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(20);

    expect(usePlayback.getState().sessionPresence).toBe("absent");
    expect(usePlayback.getState().deviceId).toBeNull();
    expect(usePlayback.getState().deviceName).toBeNull();
  });

  test("startup performs one playback read, not a short-interval polling burst", async () => {
    let reads = 0;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(100);
    expect(reads).toBe(1);
  });

  test("concurrent refresh callers share one request", async () => {
    let reads = 0;
    let release: ((state: PlaybackState) => void) | undefined;
    const pending = new Promise<PlaybackState>((resolve) => {
      release = resolve;
    });
    const player = {
      state: async () => {
        reads++;
        return await pending;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    const one = usePlayback.getState().refresh();
    const two = usePlayback.getState().refresh();
    await Bun.sleep(10);
    expect(reads).toBe(1);

    release?.(REMOTE_STATE);
    await Promise.all([one, two]);
    expect(reads).toBe(1);
  });

  test("a restarted store never reuses the previous run's unresolved read", async () => {
    let releaseFirst: ((state: PlaybackState) => void) | undefined;
    const firstPending = new Promise<PlaybackState>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReads = 0;
    let secondReads = 0;
    const firstPlayer = {
      state: async () => {
        firstReads++;
        return await firstPending;
      },
    } as unknown as PlayerApi;
    const secondPlayer = {
      state: async () => {
        secondReads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    const stopFirst = usePlayback.getState().start(firstPlayer);
    await Bun.sleep(5);
    stopFirst();
    stop = usePlayback.getState().start(secondPlayer);
    await Bun.sleep(20);

    expect(firstReads).toBe(1);
    expect(secondReads).toBe(1);
    expect(usePlayback.getState().deviceName).toBe("Living Room");
    releaseFirst?.(REMOTE_STATE);
  });

  test("several commands schedule only one reconciliation read", async () => {
    let reads = 0;
    let skips = 0;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
      next: async () => {
        skips++;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(20);
    await Promise.all([usePlayback.getState().next(), usePlayback.getState().next()]);
    await Bun.sleep(COMMAND_RECONCILE_MS + 50);

    expect(skips).toBe(2);
    expect(reads).toBe(2); // initial read + one coalesced reconciliation
  });

  test("command reconciliation cannot reuse a read that started before the mutation", async () => {
    let reads = 0;
    let releaseFirst: ((state: PlaybackState) => void) | undefined;
    const first = new Promise<PlaybackState>((resolve) => {
      releaseFirst = resolve;
    });
    const postCommandState: PlaybackState = {
      ...REMOTE_STATE,
      is_playing: false,
      progress_ms: 9_000,
    };
    const player = {
      state: async () => {
        reads++;
        return reads === 1 ? await first : postCommandState;
      },
      next: async () => {},
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(10);
    await usePlayback.getState().next();
    await Bun.sleep(COMMAND_RECONCILE_MS + 20);
    expect(reads).toBe(1);

    releaseFirst?.(REMOTE_STATE);
    await Bun.sleep(30);

    expect(reads).toBe(2);
    expect(usePlayback.getState().isPlaying).toBe(false);
    expect(usePlayback.getState().progressMs).toBe(9_000);
  });

  const optimisticScenarios = [
    {
      name: "seek",
      mutate: async () => await usePlayback.getState().seekBy(5_000),
      read: () => usePlayback.getState().progressMs,
      expected: 6_000,
      postCommandState: {
        ...REMOTE_STATE,
        is_playing: false,
        progress_ms: 6_000,
      },
    },
    {
      name: "volume",
      mutate: async () => await usePlayback.getState().adjustVolume(5),
      read: () => usePlayback.getState().volumePercent,
      expected: 55,
      postCommandState: {
        ...REMOTE_STATE,
        is_playing: false,
        device: { ...REMOTE_STATE.device!, volume_percent: 55 },
      },
    },
    {
      name: "shuffle",
      mutate: async () => await usePlayback.getState().toggleShuffle(),
      read: () => usePlayback.getState().shuffle,
      expected: true,
      postCommandState: {
        ...REMOTE_STATE,
        is_playing: false,
        shuffle_state: true,
      },
    },
    {
      name: "repeat",
      mutate: async () => await usePlayback.getState().cycleRepeat(),
      read: () => usePlayback.getState().repeat,
      expected: "context",
      postCommandState: {
        ...REMOTE_STATE,
        is_playing: false,
        repeat_state: "context" as const,
      },
    },
  ] as const;

  for (const scenario of optimisticScenarios) {
    test(`${scenario.name} rejects a stale read and performs one post-command read`, async () => {
      const initialState: PlaybackState = {
        ...REMOTE_STATE,
        is_playing: false,
      };
      let reads = 0;
      let releaseStale: ((state: PlaybackState) => void) | undefined;
      const staleRead = new Promise<PlaybackState>((resolve) => {
        releaseStale = resolve;
      });
      const player = {
        state: async () => {
          reads++;
          if (reads === 1) return initialState;
          if (reads === 2) return await staleRead;
          return scenario.postCommandState;
        },
        seek: async () => {},
        setVolume: async () => {},
        setShuffle: async () => {},
        setRepeat: async () => {},
      } as unknown as PlayerApi;

      stop = usePlayback.getState().start(player);
      await Bun.sleep(20);
      const pendingRefresh = usePlayback.getState().refresh();
      await Bun.sleep(10);
      expect(reads).toBe(2);

      await scenario.mutate();
      releaseStale?.(initialState);
      await pendingRefresh;

      expect(scenario.read()).toBe(scenario.expected);
      await Bun.sleep(COMMAND_RECONCILE_MS + 50);
      expect(reads).toBe(3);
      expect(scenario.read()).toBe(scenario.expected);
    });
  }

  test("a read started while a mutation is pending cannot satisfy reconciliation", async () => {
    const initialState: PlaybackState = {
      ...REMOTE_STATE,
      is_playing: false,
    };
    const postCommandState: PlaybackState = {
      ...initialState,
      device: { ...initialState.device!, volume_percent: 55 },
    };
    let reads = 0;
    let releaseMutation: (() => void) | undefined;
    const mutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const player = {
      state: async () => {
        reads++;
        return reads < 3 ? initialState : postCommandState;
      },
      setVolume: async () => await mutation,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(20);
    const command = usePlayback.getState().adjustVolume(5);
    await usePlayback.getState().refresh();

    expect(reads).toBe(2);
    expect(usePlayback.getState().volumePercent).toBe(55);

    releaseMutation?.();
    await command;
    await Bun.sleep(COMMAND_RECONCILE_MS + 50);

    expect(reads).toBe(3);
    expect(usePlayback.getState().volumePercent).toBe(55);
  });

  test("an early post-command refresh cannot satisfy the settle-delay barrier", async () => {
    const initialState: PlaybackState = {
      ...REMOTE_STATE,
      is_playing: false,
    };
    const settledState: PlaybackState = {
      ...initialState,
      device: { ...initialState.device!, volume_percent: 55 },
    };
    let reads = 0;
    const player = {
      state: async () => {
        reads++;
        return reads < 3 ? initialState : settledState;
      },
      setVolume: async () => {},
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(20);
    await usePlayback.getState().adjustVolume(5);
    await usePlayback.getState().refresh();

    expect(reads).toBe(2);
    expect(usePlayback.getState().volumePercent).toBe(55);

    await Bun.sleep(COMMAND_RECONCILE_MS + 50);
    expect(reads).toBe(3);
    expect(usePlayback.getState().volumePercent).toBe(55);
  });
});

describe("native receiver routing", () => {
  test("a replayed startup snapshot wins without a Web API read", async () => {
    let reads = 0;
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => true,
      onEvent: (listener: (event: EngineEvent) => void) => {
        listener({ name: "session_connected" });
        listener({
          name: "track_changed",
          media_type: "track",
          id: "native-track",
          uri: "spotify:track:native-track",
          title: "Native Track",
          duration_ms: 180_000,
          artists: [],
          covers: [],
        });
        listener({
          name: "playing",
          uri: "spotify:track:native-track",
          position_ms: 4_000,
        });
        return () => {};
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);

    expect(reads).toBe(0);
    expect(usePlayback.getState().item?.uri).toBe("spotify:track:native-track");
    expect(usePlayback.getState().isPlaying).toBe(true);
    expect(usePlayback.getState().progressMs).toBe(4_000);
  });

  test("suspending Web reconciliation leaves native playback authoritative", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let reads = 0;
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback
      .getState()
      .start(player, engine, "account", { suspendWebReconciliation: true });
    events.listener?.({ name: "session_connected" });
    events.listener?.({
      name: "track_changed",
      media_type: "track",
      id: "native-track",
      uri: "spotify:track:native-track",
      title: "Native Track",
      duration_ms: 180_000,
      artists: [],
      covers: [],
    });
    events.listener?.({
      name: "playing",
      uri: "spotify:track:native-track",
      position_ms: 4_000,
    });

    expect(reads).toBe(0);
    expect(usePlayback.getState().deviceId).toBe("native");
    expect(usePlayback.getState().item?.uri).toBe("spotify:track:native-track");

    await usePlayback.getState().resumeWebReconciliation();
    expect(reads).toBe(0);
  });

  test("resume refreshes retained native-looking state without a current-run event", async () => {
    let reads = 0;
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => true,
      onEvent: () => () => {},
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    usePlayback.setState({
      deviceId: "native",
      deviceName: "spotuify",
      sessionPresence: "present",
      ready: true,
    });
    stop = usePlayback
      .getState()
      .start(player, engine, "account", { suspendWebReconciliation: true });

    await usePlayback.getState().resumeWebReconciliation();

    expect(reads).toBe(1);
    expect(usePlayback.getState().deviceId).toBe("remote");
  });

  test("a native disconnect during suspension forces Web reconciliation on resume", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let active = true;
    let reads = 0;
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => active,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback
      .getState()
      .start(player, engine, "account", { suspendWebReconciliation: true });
    events.listener?.({ name: "session_connected" });
    events.listener?.({
      name: "playing",
      uri: "spotify:track:native-track",
      position_ms: 4_000,
    });
    active = false;
    events.listener?.({ name: "session_disconnected" });

    expect(usePlayback.getState().deviceId).toBeNull();
    await usePlayback.getState().resumeWebReconciliation();
    await Bun.sleep(COMMAND_RECONCILE_MS + 50);

    expect(reads).toBe(1);
    expect(usePlayback.getState().deviceId).toBe("remote");
  });

  test("an explicitly absent session activates before loading without a transfer", async () => {
    const order: string[] = [];
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: () => () => {},
      activate: async () => {
        order.push("activate");
      },
      transfer: async () => {
        order.push("transfer");
      },
      load: async () => {
        order.push("load");
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => null,
      play: async () => {
        order.push("web");
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    await usePlayback.getState().playSelection({
      uris: ["spotify:track:track"],
    });

    expect(order).toEqual(["activate", "load"]);
  });

  test("an absent session uses Web API when the native receiver is not ready", async () => {
    const order: string[] = [];
    const engine = {
      getStatus: () => ({ state: "starting" }) as const,
      onEvent: () => () => {},
      activate: async () => {
        order.push("activate");
      },
      load: async () => {
        order.push("native-load");
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => null,
      play: async () => {
        order.push("web");
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    await usePlayback.getState().playSelection({
      uris: ["spotify:track:track"],
    });

    expect(order).toEqual(["web"]);
  });

  test("native selections preserve the currently selected shuffle and repeat modes", async () => {
    let load:
      | {
          contextUri?: string;
          uris?: string[];
          offset?: number;
          shuffle: boolean;
          repeat: "off" | "context" | "track";
        }
      | undefined;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => true,
      onEvent: () => () => {},
      load: async (options: NonNullable<typeof load>) => {
        load = options;
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => ({
        ...REMOTE_STATE,
        shuffle_state: true,
        repeat_state: "track",
        device: { ...REMOTE_STATE.device!, id: "native", name: "spotuify" },
      }),
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    await usePlayback.getState().playSelection({
      contextUri: "spotify:album:album",
      offset: 2,
    });

    expect(load).toEqual({
      contextUri: "spotify:album:album",
      offset: 2,
      shuffle: true,
      repeat: "track",
    });
  });

  test("local transport uses librespot and performs no Web API mutation", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let nativeSkips = 0;
    let webSkips = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      next: async () => {
        nativeSkips++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
      next: async () => {
        webSkips++;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({
      name: "playing",
      uri: "spotify:track:track",
      position_ms: 2_000,
    });

    await usePlayback.getState().next();
    expect(nativeSkips).toBe(1);
    expect(webSkips).toBe(0);
  });

  test("a nullable id on an active remote device does not transfer to the native receiver", async () => {
    let nativeTransfers = 0;
    let nativeSkips = 0;
    let webSkips = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: () => () => {},
      transfer: async () => {
        nativeTransfers++;
      },
      next: async () => {
        nativeSkips++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => ({
        ...REMOTE_STATE,
        device: { ...REMOTE_STATE.device!, id: null },
      }),
      next: async () => {
        webSkips++;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    await usePlayback.getState().next();

    expect(nativeTransfers).toBe(0);
    expect(nativeSkips).toBe(0);
    expect(webSkips).toBe(1);
  });

  test("a same-named remote receiver is not mistaken for the native receiver", async () => {
    let nativeSkips = 0;
    let webSkips = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: () => () => {},
      next: async () => {
        nativeSkips++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => ({
        ...REMOTE_STATE,
        device: { ...REMOTE_STATE.device!, id: "other", name: "spotuify" },
      }),
      next: async () => {
        webSkips++;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    await usePlayback.getState().next();

    expect(nativeSkips).toBe(0);
    expect(webSkips).toBe(1);
  });

  test("a stale native Web snapshot cannot reactivate a disconnected receiver", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let active = true;
    let nativeSkips = 0;
    let webSkips = 0;
    let reads = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => active,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      next: async () => {
        nativeSkips++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return {
          ...REMOTE_STATE,
          device: { ...REMOTE_STATE.device!, id: "native", name: "spotuify" },
        };
      },
      next: async () => {
        webSkips++;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    active = false;
    events.listener?.({ name: "session_disconnected" });
    await Bun.sleep(COMMAND_RECONCILE_MS + 80);

    expect(reads).toBe(2);
    expect(usePlayback.getState().deviceId).toBeNull();
    await usePlayback.getState().next();

    expect(nativeSkips).toBe(0);
    expect(webSkips).toBe(1);
  });

  test("a delayed native disconnect preserves a picker-confirmed remote receiver", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let active = true;
    let targetDevice: string | undefined;
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => active,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => ({
        ...REMOTE_STATE,
        device: { ...REMOTE_STATE.device!, id: "native", name: "spotuify" },
      }),
      next: async (deviceId?: string) => {
        targetDevice = deviceId;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    usePlayback.getState().confirmDeviceTransfer("remote", "Living Room");
    active = false;
    events.listener?.({ name: "session_disconnected" });
    await Bun.sleep(COMMAND_RECONCILE_MS + 80);

    expect(usePlayback.getState().deviceId).toBe("remote");
    expect(usePlayback.getState().deviceName).toBe("Living Room");
    await usePlayback.getState().next();

    expect(targetDevice).toBe("remote");
  });

  test("residual native playback events cannot reclaim a confirmed remote transfer", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let active = true;
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      isActive: () => active,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => ({
        ...REMOTE_STATE,
        device: { ...REMOTE_STATE.device!, id: "native", name: "spotuify" },
      }),
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    usePlayback.getState().confirmDeviceTransfer("remote", "Living Room");

    const residualEvents: EngineEvent[] = [
      {
        name: "track_changed",
        media_type: "track",
        id: "native-track",
        uri: "spotify:track:native-track",
        title: "Native Track",
        duration_ms: 180_000,
        artists: [],
        covers: [],
      },
      {
        name: "paused",
        uri: "spotify:track:native-track",
        position_ms: 5_000,
      },
      {
        name: "playing",
        uri: "spotify:track:native-track",
        position_ms: 6_000,
      },
    ];
    for (const event of residualEvents) events.listener?.(event);
    active = false;
    events.listener?.({ name: "session_disconnected" });
    events.listener?.({
      name: "playing",
      uri: "spotify:track:native-track",
      position_ms: 7_000,
    });

    expect(usePlayback.getState().deviceId).toBe("remote");
    expect(usePlayback.getState().deviceName).toBe("Living Room");
    expect(usePlayback.getState().item?.uri).toBe("spotify:track:track");

    active = true;
    events.listener?.({ name: "session_connected" });
    events.listener?.({
      name: "track_changed",
      media_type: "track",
      id: "native-track",
      uri: "spotify:track:native-track",
      title: "Native Track",
      duration_ms: 180_000,
      artists: [],
      covers: [],
    });
    events.listener?.({
      name: "playing",
      uri: "spotify:track:native-track",
      position_ms: 8_000,
    });

    expect(usePlayback.getState().deviceId).toBe("native");
    expect(usePlayback.getState().item?.uri).toBe("spotify:track:native-track");
    expect(usePlayback.getState().progressMs).toBe(8_000);
  });

  test("a receiver authenticated as another account cannot activate or publish events", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const order: string[] = [];
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "other-account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      activate: async () => order.push("native-activate"),
      load: async () => order.push("native-load"),
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => null,
      play: async () => order.push("web-play"),
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "session_connected" });
    events.listener?.({ name: "playing", uri: "spotify:track:wrong", position_ms: 99_000 });
    await usePlayback.getState().playSelection({ uris: ["spotify:track:track"] });

    expect(order).toEqual(["web-play"]);
    expect(usePlayback.getState().deviceId).toBeNull();
    expect(usePlayback.getState().item).toBeNull();
  });

  test("failed optimistic native commands restore the last confirmed local state", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const reject = async () => {
      throw new Error("native command failed");
    };
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      play: reject,
      pause: reject,
      seek: reject,
      setVolume: reject,
      setShuffle: reject,
      setRepeat: reject,
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "playing", uri: "spotify:track:track", position_ms: 2_000 });
    events.listener?.({ name: "volume_changed", percent: 50 });
    events.listener?.({ name: "shuffle_changed", enabled: false });
    events.listener?.({ name: "repeat_changed", context: false, track: false });

    await usePlayback.getState().togglePlay();
    expect(usePlayback.getState().isPlaying).toBe(true);

    events.listener?.({ name: "paused", uri: "spotify:track:track", position_ms: 2_000 });
    await usePlayback.getState().seekBy(5_000);
    expect(usePlayback.getState().progressMs).toBe(2_000);

    await usePlayback.getState().adjustVolume(5);
    expect(usePlayback.getState().volumePercent).toBe(50);

    await usePlayback.getState().toggleShuffle();
    expect(usePlayback.getState().shuffle).toBe(false);

    await usePlayback.getState().cycleRepeat();
    expect(usePlayback.getState().repeat).toBe("off");
  });

  test("a failed command rolls back to an earlier successful mutation", async () => {
    let seekCalls = 0;
    let volumeCalls = 0;
    let shuffleCalls = 0;
    let repeatCalls = 0;
    const player = {
      state: async () => REMOTE_STATE,
      pause: async () => {},
      play: async () => {
        throw new Error("play failed");
      },
      seek: async () => {
        if (++seekCalls === 2) throw new Error("seek failed");
      },
      setVolume: async () => {
        if (++volumeCalls === 2) throw new Error("volume failed");
      },
      setShuffle: async () => {
        if (++shuffleCalls === 2) throw new Error("shuffle failed");
      },
      setRepeat: async () => {
        if (++repeatCalls === 2) throw new Error("repeat failed");
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player);
    await Bun.sleep(20);

    const pause = usePlayback.getState().togglePlay();
    const failedPlay = usePlayback.getState().togglePlay();
    await Promise.all([pause, failedPlay]);
    expect(usePlayback.getState().isPlaying).toBe(false);

    const firstSeek = usePlayback.getState().seekBy(5_000);
    const firstSeekTarget = usePlayback.getState().progressMs;
    const failedSeek = usePlayback.getState().seekBy(5_000);
    await Promise.all([firstSeek, failedSeek]);
    expect(usePlayback.getState().progressMs).toBe(firstSeekTarget);

    const firstVolume = usePlayback.getState().adjustVolume(5);
    const failedVolume = usePlayback.getState().adjustVolume(5);
    await Promise.all([firstVolume, failedVolume]);
    expect(usePlayback.getState().volumePercent).toBe(55);

    const firstShuffle = usePlayback.getState().toggleShuffle();
    const failedShuffle = usePlayback.getState().toggleShuffle();
    await Promise.all([firstShuffle, failedShuffle]);
    expect(usePlayback.getState().shuffle).toBe(true);

    const firstRepeat = usePlayback.getState().cycleRepeat();
    const failedRepeat = usePlayback.getState().cycleRepeat();
    await Promise.all([firstRepeat, failedRepeat]);
    expect(usePlayback.getState().repeat).toBe("context");
  });

  test("concurrent failed native commands roll back to authoritative state", async () => {
    type CommandName = "playing" | "seek" | "volume" | "shuffle" | "repeat";
    const events: { listener?: (event: EngineEvent) => void } = {};
    const rejectors: Record<CommandName, Array<(error: Error) => void>> = {
      playing: [],
      seek: [],
      volume: [],
      shuffle: [],
      repeat: [],
    };
    const failLater = async (command: CommandName): Promise<void> =>
      await new Promise<void>((_resolve, reject) => {
        rejectors[command].push(reject);
      });
    const rejectBoth = async (command: CommandName): Promise<void> => {
      await Bun.sleep(1);
      expect(rejectors[command]).toHaveLength(2);
      rejectors[command][0]?.(new Error(`${command} failed`));
      rejectors[command][1]?.(new Error(`${command} failed`));
    };
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      play: async () => await failLater("playing"),
      pause: async () => await failLater("playing"),
      seek: async () => await failLater("seek"),
      setVolume: async () => await failLater("volume"),
      setShuffle: async () => await failLater("shuffle"),
      setRepeat: async () => await failLater("repeat"),
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "paused", uri: "spotify:track:track", position_ms: 2_000 });
    events.listener?.({ name: "volume_changed", percent: 50 });
    events.listener?.({ name: "shuffle_changed", enabled: false });
    events.listener?.({ name: "repeat_changed", context: false, track: false });

    const firstPlay = usePlayback.getState().togglePlay();
    const secondPlay = usePlayback.getState().togglePlay();
    await rejectBoth("playing");
    await Promise.all([firstPlay, secondPlay]);
    expect(usePlayback.getState().isPlaying).toBe(false);
    expect(usePlayback.getState().progressMs).toBe(2_000);

    const firstSeek = usePlayback.getState().seekBy(5_000);
    const secondSeek = usePlayback.getState().seekBy(5_000);
    await rejectBoth("seek");
    await Promise.all([firstSeek, secondSeek]);
    expect(usePlayback.getState().progressMs).toBe(2_000);

    const firstVolume = usePlayback.getState().adjustVolume(5);
    const secondVolume = usePlayback.getState().adjustVolume(5);
    await rejectBoth("volume");
    await Promise.all([firstVolume, secondVolume]);
    expect(usePlayback.getState().volumePercent).toBe(50);

    const firstShuffle = usePlayback.getState().toggleShuffle();
    const secondShuffle = usePlayback.getState().toggleShuffle();
    await rejectBoth("shuffle");
    await Promise.all([firstShuffle, secondShuffle]);
    expect(usePlayback.getState().shuffle).toBe(false);

    const firstRepeat = usePlayback.getState().cycleRepeat();
    const secondRepeat = usePlayback.getState().cycleRepeat();
    await rejectBoth("repeat");
    await Promise.all([firstRepeat, secondRepeat]);
    expect(usePlayback.getState().repeat).toBe("off");
  });

  test("a failed play command does not overwrite a newer optimistic seek", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let rejectPlay: ((error: Error) => void) | undefined;
    let resolveSeek: (() => void) | undefined;
    const play = new Promise<void>((_resolve, reject) => {
      rejectPlay = reject;
    });
    const seek = new Promise<void>((resolve) => {
      resolveSeek = resolve;
    });
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      play: async () => await play,
      seek: async () => await seek,
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "paused", uri: "spotify:track:track", position_ms: 2_000 });

    const pendingPlay = usePlayback.getState().togglePlay();
    const pendingSeek = usePlayback.getState().seekBy(5_000);
    const optimisticSeek = usePlayback.getState().progressMs;
    await Bun.sleep(1);
    rejectPlay?.(new Error("play failed"));
    await pendingPlay;

    expect(usePlayback.getState().isPlaying).toBe(false);
    expect(usePlayback.getState().progressMs).toBe(optimisticSeek);

    resolveSeek?.();
    await pendingSeek;
  });

  test("a failed seek does not overwrite a newer optimistic play state", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let rejectSeek: ((error: Error) => void) | undefined;
    let resolvePlay: (() => void) | undefined;
    const seek = new Promise<void>((_resolve, reject) => {
      rejectSeek = reject;
    });
    const play = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      play: async () => await play,
      seek: async () => await seek,
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "paused", uri: "spotify:track:track", position_ms: 2_000 });

    const pendingSeek = usePlayback.getState().seekBy(5_000);
    const pendingPlay = usePlayback.getState().togglePlay();
    await Bun.sleep(1);
    rejectSeek?.(new Error("seek failed"));
    await pendingSeek;

    expect(usePlayback.getState().isPlaying).toBe(true);
    expect(usePlayback.getState().progressMs).toBe(2_000);

    resolvePlay?.();
    await pendingPlay;
  });

  test("a newer native command failure rolls back correctly before an older failure", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const rejectors: Array<(error: Error) => void> = [];
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      setVolume: async () =>
        await new Promise<void>((_resolve, reject) => {
          rejectors.push(reject);
        }),
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "session_connected" });
    events.listener?.({ name: "volume_changed", percent: 50 });

    const older = usePlayback.getState().adjustVolume(5);
    const newer = usePlayback.getState().adjustVolume(5);
    await Bun.sleep(1);
    rejectors[1]?.(new Error("newer failed"));
    await newer;
    expect(usePlayback.getState().volumePercent).toBe(50);

    rejectors[0]?.(new Error("older failed"));
    await older;
    expect(usePlayback.getState().volumePercent).toBe(50);
  });

  test("volume keys at a boundary do not send no-op commands", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let nativeWrites = 0;
    let webWrites = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      setVolume: async () => {
        nativeWrites++;
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
      setVolume: async () => {
        webWrites++;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "session_connected" });
    events.listener?.({ name: "volume_changed", percent: 100 });

    await usePlayback.getState().adjustVolume(5);

    expect(usePlayback.getState().volumePercent).toBe(100);
    expect(nativeWrites).toBe(0);
    expect(webWrites).toBe(0);
  });

  test("a transient native command error expires without a Web API read", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let reads = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      setVolume: async () => {
        throw new Error("native command failed");
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "session_connected" });
    events.listener?.({ name: "volume_changed", percent: 50 });

    await usePlayback.getState().adjustVolume(5);
    expect(usePlayback.getState().error).toBe("native command failed");
    expect(reads).toBe(1);

    await Bun.sleep(ERROR_LINGER_MS + 100);
    expect(usePlayback.getState().error).toBeNull();
    expect(reads).toBe(1);
  });

  test("a stopped native receiver resumes through one targeted Connect command", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const webTargets: Array<string | undefined> = [];
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      play: async () => {
        throw new NativePlaybackUnavailableError("nothing is available to resume");
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
      play: async ({ deviceId }: { deviceId?: string }) => {
        webTargets.push(deviceId);
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "paused", uri: "spotify:track:track", position_ms: 2_000 });

    await usePlayback.getState().togglePlay();

    expect(webTargets).toEqual(["native"]);
    expect(usePlayback.getState().isPlaying).toBe(true);
  });

  test("native events preserve catalog metadata and distinguish episodes", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);

    events.listener?.({
      name: "track_changed",
      media_type: "track",
      id: "catalog-track",
      uri: "spotify:track:catalog-track",
      title: "Catalog Track",
      duration_ms: 180_000,
      artists: [
        {
          id: "catalog-artist",
          name: "Catalog Artist",
          uri: "spotify:artist:catalog-artist",
        },
      ],
      album: "Album",
      covers: [
        { url: "large", width: 640, height: 640 },
        { url: "medium", width: 300, height: 300 },
        { url: "small", width: 64, height: 64 },
      ],
    });
    const track = usePlayback.getState().item;
    expect(track).not.toBeNull();
    expect(track !== null && isTrack(track)).toBe(true);
    if (track !== null && isTrack(track)) {
      expect(track.id).toBe("catalog-track");
      expect(track.artists[0]?.id).toBe("catalog-artist");
      expect(track.album.images).toEqual([
        { url: "large", width: 640, height: 640 },
        { url: "medium", width: 300, height: 300 },
        { url: "small", width: 64, height: 64 },
      ]);
      expect(chooseImage(track.album.images, 200)?.url).toBe("large");
    }

    events.listener?.({
      name: "track_changed",
      media_type: "episode",
      id: "episode",
      uri: "spotify:episode:episode",
      title: "Episode",
      duration_ms: 3_600_000,
      artists: [],
      show: "The Show",
      covers: [],
    });
    const episode = usePlayback.getState().item;
    expect(episode).not.toBeNull();
    expect(episode !== null && isTrack(episode)).toBe(false);
    if (episode !== null && !isTrack(episode)) {
      expect(episode.id).toBe("episode");
      expect(episode.show?.name).toBe("The Show");
    }
  });

  test("a terminal native stop clears ended media while end-of-track stays transitional", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const engine = {
      getStatus: () =>
        ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({
      name: "track_changed",
      media_type: "track",
      id: "native-track",
      uri: "spotify:track:native-track",
      title: "Native Track",
      duration_ms: 180_000,
      artists: [],
      covers: [],
    });
    events.listener?.({ name: "end_of_track", uri: "spotify:track:native-track" });

    expect(usePlayback.getState().item?.uri).toBe("spotify:track:native-track");

    events.listener?.({ name: "stopped", uri: "spotify:track:native-track" });
    expect(usePlayback.getState().item).toBeNull();
    expect(usePlayback.getState().progressMs).toBe(0);
    expect(usePlayback.getState().durationMs).toBe(0);
  });

  test("native position events correct locally extrapolated progress without a Web read", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let reads = 0;
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        reads++;
        return REMOTE_STATE;
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({
      name: "playing",
      uri: "spotify:track:track",
      position_ms: 2_000,
    });
    events.listener?.({
      name: "position_changed",
      uri: "spotify:track:track",
      position_ms: 42_000,
    });

    expect(usePlayback.getState().progressMs).toBe(42_000);
    expect(usePlayback.getState().deviceId).toBe("native");
    expect(reads).toBe(1);
  });

  test("a confirming native event wins over rollback after an ambiguous command failure", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let rejectVolume: ((error: Error) => void) | undefined;
    const pendingVolume = new Promise<void>((_resolve, reject) => {
      rejectVolume = reject;
    });
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
      setVolume: async () => await pendingVolume,
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => REMOTE_STATE,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(20);
    events.listener?.({ name: "session_connected" });
    events.listener?.({ name: "volume_changed", percent: 50 });

    const command = usePlayback.getState().adjustVolume(5);
    await Bun.sleep(1);
    events.listener?.({ name: "volume_changed", percent: 60 });
    rejectVolume?.(new Error("acknowledgement lost"));
    await command;

    expect(usePlayback.getState().volumePercent).toBe(60);
  });

  test("a newer native event wins over an in-flight Web API response", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let resolveState: ((state: PlaybackState) => void) | undefined;
    const pendingState = new Promise<PlaybackState>((resolve) => {
      resolveState = resolve;
    });
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => await pendingState,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    events.listener?.({
      name: "playing",
      uri: "spotify:track:track",
      position_ms: 2_000,
    });
    resolveState?.(REMOTE_STATE);
    await Bun.sleep(10);

    expect(usePlayback.getState().deviceId).toBe("native");
    expect(usePlayback.getState().deviceName).toBe("spotuify");
  });

  test("authoritative native playback clears an irrelevant Web API error", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => {
        throw new Error("web api unavailable");
      },
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    await Bun.sleep(10);
    expect(usePlayback.getState().error).not.toBeNull();

    events.listener?.({
      name: "playing",
      uri: "spotify:track:track",
      position_ms: 2_000,
    });

    expect(usePlayback.getState().error).toBeNull();
    expect(usePlayback.getState().deviceName).toBe("spotuify");
  });

  test("native activation claims playback and invalidates an older Web API response", async () => {
    const events: { listener?: (event: EngineEvent) => void } = {};
    let resolveState: ((state: PlaybackState) => void) | undefined;
    const pendingState = new Promise<PlaybackState>((resolve) => {
      resolveState = resolve;
    });
    const engine = {
      getStatus: () => ({ state: "ready", pid: 1, deviceId: "native", accountId: "account" }) as const,
      onEvent: (next: (event: EngineEvent) => void) => {
        events.listener = next;
        return () => {
          delete events.listener;
        };
      },
    } as unknown as LibrespotEngine;
    const player = {
      state: async () => await pendingState,
    } as unknown as PlayerApi;

    stop = usePlayback.getState().start(player, engine, "account");
    events.listener?.({ name: "session_connected" });
    resolveState?.(REMOTE_STATE);
    await Bun.sleep(10);

    expect(usePlayback.getState().deviceId).toBe("native");
    expect(usePlayback.getState().deviceName).toBe("spotuify");
    expect(usePlayback.getState().sessionPresence).toBe("present");
  });
});
