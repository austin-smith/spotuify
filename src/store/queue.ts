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
  /** Index of the first up-next item on screen. The queue has no selection, so this is pure scroll. */
  offset: number;

  configure: (player: PlayerApi) => void;
  openQueue: () => void;
  closeQueue: () => void;
  refresh: () => Promise<void>;
  /** Append an item, then refresh so the new tail is visible. */
  enqueue: (uri: string, label: string) => Promise<void>;
  clearNotice: () => void;
  scrollBy: (delta: number, viewport: number) => void;
  scrollToEdge: (edge: "top" | "bottom", viewport: number) => void;
  /** Keep the scroll inside the list after a refresh shrank it or the terminal was resized. */
  clampOffset: (viewport: number) => void;
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
  offset: 0,

  configure(nextPlayer) {
    player = nextPlayer;
  },

  openQueue() {
    // From the top on every open: the interesting end of a queue is what plays next.
    set({ open: true, notice: null, offset: 0 });
    void get().refresh();
  },

  closeQueue() {
    inFlight?.abort();
    inFlight = null;
    set({ open: false, loading: false, error: null, offset: 0 });
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

  scrollBy(delta, viewport) {
    const { offset, upNext } = get();
    // Never scroll the last item off the top: past the end there is nothing to read, and a blank
    // list looks like the queue emptied.
    const max = Math.max(0, upNext.length - Math.max(1, viewport));
    set({ offset: Math.min(max, Math.max(0, offset + delta)) });
  },

  scrollToEdge(edge, viewport) {
    const max = Math.max(0, get().upNext.length - Math.max(1, viewport));
    set({ offset: edge === "top" ? 0 : max });
  },

  clampOffset(viewport) {
    const max = Math.max(0, get().upNext.length - Math.max(1, viewport));
    set(({ offset }) => ({ offset: Math.min(offset, max) }));
  },
}));
