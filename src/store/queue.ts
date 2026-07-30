import { create } from "zustand";
import type { PlayerApi } from "../api/player.ts";
import type { PlayableItem } from "../api/types.ts";

export interface QueueSlice {
  open: boolean;
  nowPlaying: PlayableItem | null;
  upNext: PlayableItem[];
  loading: boolean;
  error: string | null;
  /** Transient confirmation after queueing something, cleared on the next action. */
  notice: string | null;

  configure: (player: PlayerApi) => void;
  openQueue: () => void;
  closeQueue: () => void;
  refresh: () => Promise<void>;
  /** Append an item, then refresh so the new tail is visible. */
  enqueue: (uri: string, label: string) => Promise<void>;
  clearNotice: () => void;
}

let player: PlayerApi | null = null;
let inFlight: AbortController | null = null;

export const useQueue = create<QueueSlice>((set, get) => ({
  open: false,
  nowPlaying: null,
  upNext: [],
  loading: false,
  error: null,
  notice: null,

  configure(nextPlayer) {
    player = nextPlayer;
  },

  openQueue() {
    set({ open: true, notice: null });
    void get().refresh();
  },

  closeQueue() {
    inFlight?.abort();
    inFlight = null;
    set({ open: false, loading: false, error: null });
  },

  async refresh() {
    if (player === null) return;

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    set({ loading: true, error: null });
    try {
      const { currently_playing, queue } = await player.queue(controller.signal);
      if (controller.signal.aborted) return;
      set({ nowPlaying: currently_playing, upNext: queue, loading: false });
    } catch (err) {
      if (controller.signal.aborted) return;
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  async enqueue(uri, label) {
    if (player === null) return;
    try {
      await player.addToQueue(uri);
      set({ notice: `queued ${label}`, error: null });
      // Only worth refetching while the queue is on screen.
      if (get().open) await get().refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  clearNotice() {
    set({ notice: null });
  },
}));
