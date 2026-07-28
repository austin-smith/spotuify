import { create } from "zustand";
import { albumTracks, artistAlbums } from "../api/catalog.ts";
import type { SpotifyClient } from "../api/client.ts";
import { EMPTY_HOME, fetchHome, type HomeData } from "../api/library.ts";
import { search } from "../api/search.ts";
import {
  filterRows,
  firstSelectable,
  moveSelection,
  toAlbumRows,
  toArtistRows,
  toHomeRows,
  toRows,
  type Drill,
  type Row,
} from "./rows.ts";

/** Wait this long after the last keystroke before querying. */
const DEBOUNCE_MS = 180;

/**
 * One level of the palette.
 *
 * The root frame is home-or-search; drilling pushes a frame whose rows come from the catalog. Each
 * frame keeps its own selection so popping back lands where you left off.
 */
interface Frame {
  /** Breadcrumb label. Absent on the root, which shows the search prompt instead. */
  title?: string;
  rows: Row[];
  selected: number;
  loading: boolean;
  /** Local filter text, used by drilled frames instead of a network query. */
  filter: string;
}

export interface SearchSlice {
  open: boolean;
  /** Search text for the root frame. */
  query: string;
  frames: Frame[];
  error: string | null;
  /** True while the root frame is showing the pre-typing view. */
  showingHome: boolean;

  configure: (client: SpotifyClient, market: string | undefined) => void;
  openPalette: () => void;
  /** Open straight into an album or artist, skipping the search prompt. */
  openAt: (target: Drill) => void;
  closePalette: () => void;
  /** Types into whichever frame is on top: a search query at the root, a filter when drilled. */
  setQuery: (query: string) => void;
  /** Move the highlight within the list. */
  move: (delta: number) => void;
  /** Push a deeper frame. */
  drillInto: (target: Drill) => void;
  /** Pop one level. Returns false at the root, so the caller can close the palette. */
  back: () => boolean;

  // Derived accessors for the view.
  rows: () => Row[];
  selected: () => number;
  loading: () => boolean;
  depth: () => number;
  breadcrumb: () => string | null;
  text: () => string;
  current: () => Extract<Row, { kind: "result" }> | null;
}

let client: SpotifyClient | null = null;
let market: string | undefined;
let debounce: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;
let drillLoad: AbortController | null = null;
/**
 * Tracked separately from `drillLoad`.
 *
 * Opening straight into an album drills immediately, and a shared controller meant that drill
 * cancelled the home fetch it had just started — leaving the root frame loading forever, so escaping
 * back out landed on a spinner that never resolved.
 */
let homeLoad: AbortController | null = null;
/** Cached for the session; the pre-typing view is stable enough not to refetch on every open. */
let home: HomeData = EMPTY_HOME;

/**
 * A frame with its first row highlighted.
 *
 * Highlighting on arrival is the combobox convention: the text field keeps the caret throughout and
 * the highlight marks your place in the list rather than competing for focus.
 */
const frameOf = (rows: Row[], title?: string): Frame => ({
  rows,
  selected: firstSelectable(rows),
  loading: false,
  filter: "",
  ...(title !== undefined ? { title } : {}),
});

const loadingFrame = (title?: string): Frame => ({
  rows: [],
  selected: -1,
  loading: true,
  filter: "",
  ...(title !== undefined ? { title } : {}),
});

/** Replace the top frame. */
function withTop(frames: Frame[], patch: Partial<Frame>): Frame[] {
  const next = [...frames];
  const top = next[next.length - 1];
  if (top !== undefined) next[next.length - 1] = { ...top, ...patch };
  return next;
}

function topOf(frames: Frame[]): Frame | undefined {
  return frames[frames.length - 1];
}

function cancelPending(): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
  inFlight?.abort();
  inFlight = null;
}

export const useSearch = create<SearchSlice>((set, get) => ({
  open: false,
  query: "",
  frames: [frameOf([])],
  error: null,
  showingHome: true,

  configure(nextClient, nextMarket) {
    client = nextClient;
    market = nextMarket;
  },

  openPalette() {
    set({
      open: true,
      query: "",
      frames: [frameOf(toHomeRows(home))],
      error: null,
      showingHome: true,
    });

    if (home !== EMPTY_HOME || client === null) return;

    set({ frames: [loadingFrame()] });
    const controller = new AbortController();
    homeLoad = controller;

    void (async () => {
      try {
        const data = await fetchHome(client, { market, signal: controller.signal });
        if (controller.signal.aborted) return;
        home = data;
        // A drilled frame owns the view now, so leave it alone — clearing its loading flag here
        // would blank the list while the drill is still in flight. `back()` fills the root frame in
        // from this cache on the way out.
        if (get().frames.length !== 1) return;
        // A query typed while this was loading takes precedence.
        if (get().query.trim().length === 0) {
          set({ frames: [frameOf(toHomeRows(data))], showingHome: true });
        } else {
          set({ frames: withTop(get().frames, { loading: false }) });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        set({
          frames: withTop(get().frames, { loading: false }),
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (homeLoad === controller) homeLoad = null;
      }
    })();
  },

  /**
   * Open the palette already inside an album or artist.
   *
   * The root frame is still pushed underneath, so escape lands on home-or-search rather than
   * closing outright — the same place `back()` would take you from any other drilled frame.
   */
  openAt(target) {
    get().openPalette();
    get().drillInto(target);
  },

  closePalette() {
    // Drop pending and in-flight work so a late response cannot repopulate a closed palette.
    cancelPending();
    drillLoad?.abort();
    drillLoad = null;
    homeLoad?.abort();
    homeLoad = null;
    set({ open: false, query: "", frames: [frameOf([])], error: null, showingHome: true });
  },

  setQuery(text) {
    const { frames } = get();

    // A drilled list filters its own rows locally — no request per keystroke.
    if (frames.length > 1) {
      const top = topOf(frames);
      if (top === undefined) return;
      const visible = filterRows(top.rows, text);
      set({ frames: withTop(frames, { filter: text, selected: firstSelectable(visible) }) });
      return;
    }

    set({ query: text });
    cancelPending();

    // Clearing the query returns to the pre-typing view rather than a blank screen.
    if (text.trim().length === 0) {
      set({ frames: [frameOf(toHomeRows(home))], showingHome: true, error: null });
      return;
    }

    // Clear the old rows immediately. Leaving them up means the highlight sits on a row that no
    // longer matches what is on screen, which is how a home track once played mid-search.
    set({ frames: [loadingFrame()], showingHome: false });

    debounce = setTimeout(() => {
      debounce = null;
      if (client === null) return;

      const controller = new AbortController();
      inFlight = controller;

      void (async () => {
        try {
          const results = await search(client, text, { market, signal: controller.signal });
          // A newer keystroke may have superseded this request while it was in flight.
          if (controller.signal.aborted || get().query !== text) return;
          set({ frames: [frameOf(toRows(results))], showingHome: false, error: null });
        } catch (err) {
          if (controller.signal.aborted) return;
          set({
            frames: withTop(get().frames, { loading: false }),
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (inFlight === controller) inFlight = null;
        }
      })();
    }, DEBOUNCE_MS);
  },

  move(delta) {
    const top = topOf(get().frames);
    if (top === undefined) return;
    const visible = filterRows(top.rows, top.filter);
    if (visible.length === 0) return;
    set({
      frames: withTop(get().frames, { selected: moveSelection(visible, top.selected, delta) }),
    });
  },

  drillInto(target) {
    if (client === null) return;

    drillLoad?.abort();
    const controller = new AbortController();
    drillLoad = controller;

    set({ frames: [...get().frames, loadingFrame(target.name)], error: null });

    void (async () => {
      try {
        const rows =
          target.kind === "artist"
            ? toArtistRows(
                await artistAlbums(client, target.id, { market, signal: controller.signal }),
              )
            : toAlbumRows(
                { name: target.name, uri: target.uri },
                await albumTracks(client, target.id, { market, signal: controller.signal }),
              );
        if (controller.signal.aborted) return;
        set({
          frames: withTop(get().frames, { rows, selected: firstSelectable(rows), loading: false }),
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        set({
          frames: withTop(get().frames, { loading: false }),
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (drillLoad === controller) drillLoad = null;
      }
    })();
  },

  back() {
    const { frames, query } = get();
    if (frames.length <= 1) return false;
    drillLoad?.abort();
    drillLoad = null;

    const remaining = frames.slice(0, -1);
    // Opening straight into an album leaves the root frame unfilled, because the home fetch
    // deliberately skips a view a deeper frame owns. Fill it in here so escaping out shows home
    // rather than the spinner it was left on.
    const root = remaining[0];
    if (remaining.length === 1 && root !== undefined && root.rows.length === 0 && query === "") {
      set({ frames: [frameOf(toHomeRows(home))], showingHome: true, error: null });
      return true;
    }

    set({ frames: remaining, error: null });
    return true;
  },

  rows() {
    const top = topOf(get().frames);
    return top === undefined ? [] : filterRows(top.rows, top.filter);
  },

  selected() {
    return topOf(get().frames)?.selected ?? -1;
  },

  loading() {
    return topOf(get().frames)?.loading ?? false;
  },

  depth() {
    return get().frames.length;
  },

  breadcrumb() {
    const titles = get()
      .frames.map((f) => f.title)
      .filter((t): t is string => t !== undefined);
    return titles.length === 0 ? null : titles.join("  ›  ");
  },

  text() {
    const { frames, query } = get();
    return frames.length > 1 ? (topOf(frames)?.filter ?? "") : query;
  },

  current() {
    const rows = get().rows();
    const row = rows[get().selected()];
    return row?.kind === "result" ? row : null;
  },
}));
