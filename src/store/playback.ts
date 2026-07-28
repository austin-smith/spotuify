import { create } from "zustand";
import { PlayerApi, nextRepeatState } from "../api/player.ts";
import type { PlayableItem, PlaybackState, RepeatState } from "../api/types.ts";
import { extrapolate, type ProgressAnchor } from "./progress.ts";

/** How often to reconcile with Spotify. 5s keeps us near 12 req/min at idle. */
const POLL_INTERVAL_MS = 5_000;
/** How often to recompute extrapolated progress for the UI. */
const TICK_INTERVAL_MS = 250;

export interface PlaybackSlice {
  item: PlayableItem | null;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatState;
  volumePercent: number | null;
  deviceId: string | null;
  deviceName: string | null;
  /** Extrapolated position, refreshed every tick. */
  progressMs: number;
  durationMs: number;
  /** Last error surfaced to the user; cleared on the next successful poll. */
  error: string | null;
  /** False until the first poll resolves, so the UI can show a loading state. */
  ready: boolean;

  start: (player: PlayerApi) => () => void;
  refresh: () => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seekBy: (deltaMs: number) => Promise<void>;
  adjustVolume: (delta: number) => Promise<void>;
  toggleShuffle: () => Promise<void>;
  cycleRepeat: () => Promise<void>;
}

/** Mutable, non-reactive internals — kept out of the store so they never trigger a render. */
let api: PlayerApi | null = null;
let anchor: ProgressAnchor = { progressMs: 0, atMs: 0, isPlaying: false, durationMs: 0 };

function applyState(state: PlaybackState | null): Partial<PlaybackSlice> {
  if (state === null || state.item === null) {
    anchor = { progressMs: 0, atMs: performance.now(), isPlaying: false, durationMs: 0 };
    return {
      item: null,
      isPlaying: false,
      progressMs: 0,
      durationMs: 0,
      deviceId: null,
      deviceName: null,
      error: null,
      ready: true,
    };
  }

  const durationMs = state.item.duration_ms;
  anchor = {
    progressMs: state.progress_ms ?? 0,
    atMs: performance.now(),
    isPlaying: state.is_playing,
    durationMs,
  };

  return {
    item: state.item,
    isPlaying: state.is_playing,
    shuffle: state.shuffle_state,
    repeat: state.repeat_state,
    volumePercent: state.device?.volume_percent ?? null,
    deviceId: state.device?.id ?? null,
    deviceName: state.device?.name ?? null,
    progressMs: anchor.progressMs,
    durationMs,
    error: null,
    ready: true,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const usePlayback = create<PlaybackSlice>((set, get) => ({
  item: null,
  isPlaying: false,
  shuffle: false,
  repeat: "off",
  volumePercent: null,
  deviceId: null,
  deviceName: null,
  progressMs: 0,
  durationMs: 0,
  error: null,
  ready: false,

  /** Begin polling. Returns a disposer that stops both timers. */
  start(player) {
    api = player;
    void get().refresh();

    const poll = setInterval(() => void get().refresh(), POLL_INTERVAL_MS);
    const tick = setInterval(() => {
      const next = extrapolate(anchor, performance.now());
      // Only write when the rendered second changes, so we don't re-render 4x/sec for nothing.
      if (Math.floor(next / 1000) !== Math.floor(get().progressMs / 1000)) {
        set({ progressMs: next });
      }
    }, TICK_INTERVAL_MS);

    return () => {
      clearInterval(poll);
      clearInterval(tick);
      api = null;
    };
  },

  async refresh() {
    if (api === null) return;
    try {
      set(applyState(await api.state()));
    } catch (err) {
      set({ error: describe(err), ready: true });
    }
  },

  /**
   * Optimistically flip the play state so the UI responds immediately, then reconcile.
   * On failure the next poll restores the truth.
   */
  async togglePlay() {
    if (api === null) return;
    const { isPlaying, deviceId } = get();
    set({ isPlaying: !isPlaying });
    anchor = { ...anchor, progressMs: extrapolate(anchor, performance.now()), atMs: performance.now(), isPlaying: !isPlaying };
    try {
      if (isPlaying) await api.pause(deviceId ?? undefined);
      else await api.play({ ...(deviceId !== null ? { deviceId } : {}) });
    } catch (err) {
      set({ error: describe(err) });
    }
    await get().refresh();
  },

  async next() {
    if (api === null) return;
    try {
      await api.next(get().deviceId ?? undefined);
    } catch (err) {
      set({ error: describe(err) });
    }
    // Spotify needs a beat to settle on the new track before /me/player reflects it.
    await Bun.sleep(300);
    await get().refresh();
  },

  async previous() {
    if (api === null) return;
    try {
      await api.previous(get().deviceId ?? undefined);
    } catch (err) {
      set({ error: describe(err) });
    }
    await Bun.sleep(300);
    await get().refresh();
  },

  async seekBy(deltaMs) {
    if (api === null) return;
    const { durationMs, deviceId } = get();
    const target = Math.min(durationMs, Math.max(0, extrapolate(anchor, performance.now()) + deltaMs));
    anchor = { ...anchor, progressMs: target, atMs: performance.now() };
    set({ progressMs: target });
    try {
      await api.seek(target, deviceId ?? undefined);
    } catch (err) {
      set({ error: describe(err) });
      await get().refresh();
    }
  },

  async adjustVolume(delta) {
    if (api === null) return;
    const { volumePercent, deviceId } = get();
    if (volumePercent === null) return;
    const target = Math.min(100, Math.max(0, volumePercent + delta));
    set({ volumePercent: target });
    try {
      await api.setVolume(target, deviceId ?? undefined);
    } catch (err) {
      set({ error: describe(err) });
      await get().refresh();
    }
  },

  async toggleShuffle() {
    if (api === null) return;
    const { shuffle, deviceId } = get();
    set({ shuffle: !shuffle });
    try {
      await api.setShuffle(!shuffle, deviceId ?? undefined);
    } catch (err) {
      set({ error: describe(err) });
      await get().refresh();
    }
  },

  async cycleRepeat() {
    if (api === null) return;
    const { repeat, deviceId } = get();
    const mode = nextRepeatState(repeat);
    set({ repeat: mode });
    try {
      await api.setRepeat(mode, deviceId ?? undefined);
    } catch (err) {
      set({ error: describe(err) });
      await get().refresh();
    }
  },
}));
