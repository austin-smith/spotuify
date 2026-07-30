import { create } from "zustand";
import { fetchLyrics, type Lyrics } from "../api/lyrics.ts";
import { isTrack, type PlayableItem } from "../api/types.ts";

/**
 * Lyrics already looked up this session.
 *
 * Reopening the overlay on the track you just closed it on should be instant, and Genius is two
 * requests and up to four seconds away. Bounded because a long session skips through a lot of music.
 */
const cache = new Map<string, Lyrics>();
const MAX_CACHED = 32;

function remember(key: string, lyrics: Lyrics): void {
  cache.set(key, lyrics);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/** Identity of a track for caching. Local files have no id, so the uri is the fallback. */
function keyOf(item: PlayableItem): string {
  return item.id ?? item.uri;
}

export interface LyricsSlice {
  open: boolean;
  loading: boolean;
  error: string | null;
  lyrics: Lyrics | null;
  /** Index of the first display line on screen. */
  offset: number;
  /** Display lines the view is rendering, which is what scrolling has to clamp against. */
  total: number;
  /** The track the current lyric belongs to, so a track change can be noticed. */
  trackKey: string | null;
  /**
   * Whether the view scrolls itself to keep the sung line in sight.
   *
   * On until the reader scrolls by hand, because taking the scroll back from someone mid-verse is
   * infuriating. A new track turns it back on.
   */
  following: boolean;

  openLyrics: (item: PlayableItem | null) => void;
  closeLyrics: () => void;
  /** Load the new track's lyric if the overlay is open and the track actually changed. */
  follow: (item: PlayableItem | null) => void;
  scrollBy: (delta: number, viewport: number) => void;
  /** Programmatic scroll, which does not count as taking over. */
  scrollTo: (offset: number) => void;
  setFollowing: (following: boolean) => void;
  /** Record a relayout and keep the current scroll position inside its new viewport. */
  setTotal: (total: number, viewport: number) => void;
}

let inFlight: AbortController | null = null;

export const useLyrics = create<LyricsSlice>((set, get) => ({
  open: false,
  loading: false,
  error: null,
  lyrics: null,
  offset: 0,
  total: 0,
  trackKey: null,
  following: true,

  openLyrics(item) {
    if (item === null) {
      set({
        open: true,
        loading: false,
        error: "nothing playing",
        lyrics: null,
        trackKey: null,
        following: true,
      });
      return;
    }

    // Podcasts have no lyric to find, and searching Genius for an episode title returns a
    // confidently wrong song.
    if (!isTrack(item)) {
      set({
        open: true,
        loading: false,
        error: "lyrics are only available for music",
        lyrics: null,
        trackKey: keyOf(item),
        offset: 0,
        following: true,
      });
      return;
    }

    const key = keyOf(item);
    const cached = cache.get(key);
    if (cached !== undefined) {
      set({
        open: true,
        loading: false,
        error: null,
        lyrics: cached,
        trackKey: key,
        offset: 0,
        following: true,
      });
      return;
    }

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    set({
      open: true,
      loading: true,
      error: null,
      lyrics: null,
      trackKey: key,
      offset: 0,
      following: true,
    });

    void (async () => {
      try {
        const lyrics = await fetchLyrics(
          {
            name: item.name,
            artists: item.artists.map((artist) => artist.name),
            // LRCLIB matches on length: it is how a live cut is told from the studio recording.
            durationMs: item.duration_ms,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        remember(key, lyrics);
        // The track may have moved on while Genius was answering; a late lyric must not replace the
        // one belonging to whatever is playing now.
        if (get().trackKey !== key) return;
        set({ loading: false, lyrics, error: null, offset: 0, following: true });
      } catch (err) {
        if (controller.signal.aborted || get().trackKey !== key) return;
        set({
          loading: false,
          lyrics: null,
          error: err instanceof Error ? err.message.toLowerCase() : String(err),
        });
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    })();
  },

  closeLyrics() {
    inFlight?.abort();
    inFlight = null;
    set({ open: false, loading: false, offset: 0 });
  },

  follow(item) {
    const { open, trackKey } = get();
    if (!open) return;
    const key = item === null ? null : keyOf(item);
    if (key === trackKey) return;
    get().openLyrics(item);
  },

  scrollBy(delta, viewport) {
    const { offset, total } = get();
    // Never scroll the last line off the top: past the end there is nothing to read, and a blank
    // screen looks like the lyric failed to load.
    const max = Math.max(0, total - viewport);
    // Scrolling by hand is how the reader says they want to look somewhere else.
    set({ offset: Math.min(max, Math.max(0, offset + delta)), following: false });
  },

  scrollTo(offset) {
    set({ offset: Math.max(0, offset) });
  },

  setFollowing(following) {
    set({ following });
  },

  setTotal(total, viewport) {
    const boundedTotal = Math.max(0, total);
    const max = Math.max(0, boundedTotal - Math.max(1, viewport));
    set(({ offset }) => ({ total: boundedTotal, offset: Math.min(offset, max) }));
  },
}));
