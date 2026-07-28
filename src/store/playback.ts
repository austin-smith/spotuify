import { create } from "zustand";
import {
  PlayerCommandRejectedError,
  PremiumRequiredError,
  SpotifyApiError,
} from "../api/client.ts";
import { PlayerApi, nextRepeatState } from "../api/player.ts";
import type { PlayableItem, PlaybackState, RepeatState } from "../api/types.ts";
import { ReauthRequiredError } from "../auth/tokens.ts";
import { extrapolate, type ProgressAnchor } from "./progress.ts";

/** How often to reconcile with Spotify. 5s keeps us near 12 req/min at idle. */
const POLL_INTERVAL_MS = 5_000;
/** How often to recompute extrapolated progress for the UI. */
const TICK_INTERVAL_MS = 250;
/**
 * How long an error stays up before a successful poll is allowed to clear it.
 *
 * Every command refreshes immediately after running, so without this any failure was wiped roughly
 * 300ms later: long enough to flash red, far too short to read.
 */
export const ERROR_LINGER_MS = 4_000;

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
/** When the current error was raised, for `ERROR_LINGER_MS`. */
let errorAt = 0;

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
    ready: true,
  };
}

/**
 * A sentence the user can act on.
 *
 * Raw API text ("Spotify API 404 on /me/player/next: Device not found") names an endpoint the user
 * never asked about and says nothing about what to do next.
 */
function describe(err: unknown): string {
  if (err instanceof PremiumRequiredError) return "playback control needs spotify premium";
  if (err instanceof ReauthRequiredError) return "session expired — run: spotuify auth";

  if (err instanceof SpotifyApiError) {
    if (err.status === 404) return "no active device — press d to pick one";
    if (err.status === 429) return "spotify is rate limiting — try again in a moment";
    if (err.status >= 500) return "spotify is having trouble — retrying";
    return err.detail.toLowerCase();
  }

  // Offline and DNS failures arrive as TypeError from fetch, with a message that varies by platform.
  if (err instanceof TypeError) return "cannot reach spotify — check your connection";
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a failure, unless Spotify merely declined the command.
 *
 * A rejected transport command is an outcome, not a fault: pressing previous at the start of a
 * context cannot go anywhere, and Spotify's own clients do nothing rather than complain.
 */
function fail(set: (patch: Partial<PlaybackSlice>) => void, err: unknown): void {
  if (err instanceof PlayerCommandRejectedError) return;
  errorAt = performance.now();
  set({ error: describe(err) });
}

/** Whether a successful poll may clear the error that is up. */
function errorIsStale(current: string | null): boolean {
  return current !== null && performance.now() - errorAt >= ERROR_LINGER_MS;
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
      const next = applyState(await api.state());
      // A poll that succeeds does not get to wipe an error the user has not had time to read; the
      // commands all refresh within 300ms of failing.
      set(errorIsStale(get().error) ? { ...next, error: null } : next);
    } catch (err) {
      fail(set, err);
      set({ ready: true });
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
      fail(set, err);
    }
    await get().refresh();
  },

  async next() {
    if (api === null) return;
    try {
      await api.next(get().deviceId ?? undefined);
    } catch (err) {
      fail(set, err);
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
      fail(set, err);
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
      fail(set, err);
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
      fail(set, err);
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
      fail(set, err);
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
      fail(set, err);
      await get().refresh();
    }
  },
}));
