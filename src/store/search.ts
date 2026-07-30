import { create } from "zustand";
import { albumTracks, artistAlbums } from "../api/catalog.ts";
import type { SpotifyClient } from "../api/client.ts";
import { EMPTY_HOME, fetchHome, type HomeData } from "../api/library.ts";
import { playlistItems } from "../api/playlists.ts";
import { search, type SearchResults } from "../api/search.ts";
import {
  filterRows,
  firstSelectable,
  matchPlaylists,
  moveSelection,
  toAlbumRows,
  toArtistRows,
  toHomeRows,
  toPlaylistRows,
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
  /**
   * The source data for a root search frame.
   *
   * Playlist metadata loads independently from the Spotify search request. Keeping the source lets
   * that later response add matching owned playlists without issuing the search again.
   */
  search?: { query: string; results: SearchResults };
}

export interface SearchSlice {
  open: boolean;
  /** Search text for the root frame. */
  query: string;
  frames: Frame[];
  error: string | null;
  /** True while the root frame is showing the pre-typing view. */
  showingHome: boolean;

  configure: (client: SpotifyClient, market: string | undefined, meId: string) => void;
  openPalette: () => void;
  /** Open straight into an album, artist or playlist, skipping the search prompt. */
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
/** Spotify id of the signed-in user; only their own playlists can be opened. */
let meId = "";
let debounce: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;
let drillLoad: AbortController | null = null;
/**
 * Tracked separately from `drillLoad`.
 *
 * Opening straight into an album drills immediately, and a shared controller meant that drill
 * canceled the home fetch it had just started — leaving the root frame loading forever, so escaping
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
const frameOf = (
  rows: Row[],
  title?: string,
  searchSource?: { query: string; results: SearchResults },
): Frame => ({
  rows,
  selected: firstSelectable(rows),
  loading: false,
  filter: "",
  ...(title !== undefined ? { title } : {}),
  ...(searchSource !== undefined ? { search: searchSource } : {}),
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

type ResultRow = Extract<Row, { kind: "result" }>;

/** Stable identity for preserving a result selection when groups are inserted around it. */
function resultKey(row: ResultRow): string {
  if (row.drill !== undefined) return `${row.drill.kind}:${row.drill.id}`;
  if ("uris" in row.play) return `uris:${row.play.uris.join("\u0000")}`;
  return `context:${row.play.contextUri}`;
}

function replaceRootRows(
  root: Frame,
  rows: Row[],
  searchSource?: { query: string; results: SearchResults },
): Frame {
  const selected = root.rows[root.selected];
  const key = selected?.kind === "result" ? resultKey(selected) : null;
  const next = frameOf(rows, root.title, searchSource);
  if (key === null) return next;

  const selectedIndex = next.rows.findIndex(
    (row) => row.kind === "result" && resultKey(row) === key,
  );
  return selectedIndex === -1 ? next : { ...next, selected: selectedIndex };
}

/** The rows behind one drill target. */
async function rowsFor(
  client: SpotifyClient,
  target: Drill,
  options: { market?: string; signal: AbortSignal },
): Promise<Row[]> {
  switch (target.kind) {
    case "artist":
      return toArtistRows(await artistAlbums(client, target.id, options));
    case "album":
      return toAlbumRows(
        { name: target.name, uri: target.uri },
        await albumTracks(client, target.id, options),
      );
    case "playlist":
      return toPlaylistRows(
        { name: target.name, uri: target.uri },
        await playlistItems(client, target.id, options),
      );
  }
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

  configure(nextClient, nextMarket, nextMeId) {
    if (client !== nextClient || market !== nextMarket || meId !== nextMeId) {
      // The cache belongs to one authenticated client and market. Reconfiguration is rare, but
      // retaining another account's library would be both stale and a privacy bug.
      cancelPending();
      drillLoad?.abort();
      drillLoad = null;
      homeLoad?.abort();
      homeLoad = null;
      home = EMPTY_HOME;
      set({
        open: false,
        query: "",
        frames: [frameOf([])],
        error: null,
        showingHome: true,
      });
    }
    client = nextClient;
    market = nextMarket;
    meId = nextMeId;
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
        const data = await fetchHome(client, { market, meId, signal: controller.signal });
        if (controller.signal.aborted) return;
        home = data;
        const { frames, query } = get();

        // Fill the root even when a drilled frame currently owns the screen. Only the first frame
        // changes, so the active drill and its loading state remain untouched while Back is made
        // ready with the newly loaded library.
        if (query.trim().length === 0) {
          set({
            frames: [frameOf(toHomeRows(data)), ...frames.slice(1)],
            showingHome: true,
          });
          return;
        }

        // Search may have completed while the playlist library was still loading. Rebuild that
        // frame from its source response so owned playlist-name matches appear without another
        // network search or an extra keystroke. If search is still loading, it will use `home`
        // itself when its response arrives.
        const root = frames[0];
        if (root?.search?.query === query) {
          const context = {
            meId,
            libraryMatches: matchPlaylists(data.playlists, query),
          };
          set({
            frames: [
              replaceRootRows(
                root,
                toRows(root.search.results, context),
                root.search,
              ),
              ...frames.slice(1),
            ],
            showingHome: false,
          });
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
   * Open the palette already inside an album, artist or playlist.
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
          const context = {
            meId,
            libraryMatches: matchPlaylists(home.playlists, text),
          };
          set({
            frames: [
              frameOf(toRows(results, context), undefined, { query: text, results }),
            ],
            showingHome: false,
            error: null,
          });
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
        const rows = await rowsFor(client, target, { market, signal: controller.signal });
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
    // Back can beat the home request when opening straight into a drill. Fill the root from whatever
    // is cached now rather than briefly returning to the spinner; the request will replace it when
    // it settles.
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
