import { create } from "zustand";
import type { SpotifyClient } from "../api/client.ts";
import { EMPTY_HOME, fetchHome, type HomeData } from "../api/library.ts";
import {
  resolveSpotifyReference,
  supportsSpotifyReference,
} from "../api/references.ts";
import { eligibleSearchTypes } from "../api/search-query.ts";
import {
  scopeForCategory,
  search,
  type SearchCategory,
  type SearchResults,
  type SearchScope,
} from "../api/search.ts";
import {
  looksLikeSpotifyReference,
  parseSpotifyReference,
} from "../spotify/reference.ts";
import { rowsForDrill } from "./drill.ts";
import { failureMessage } from "./error.ts";
import { usePlaylistCatalog } from "./playlists.ts";
import {
  filterRows,
  firstSelectable,
  isSelectable,
  matchPlaylists,
  moveSelection,
  moveSelectionPage,
  toHomeRows,
  toReferenceRows,
  toRows,
  type Drill,
  type Row,
  type SelectableRow,
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
  search?: { query: string; scope: SearchScope; results: SearchResults };
}

export interface SearchSlice {
  open: boolean;
  /** Search text for the root frame. */
  query: string;
  scope: SearchScope;
  frames: Frame[];
  error: string | null;
  /** True while the root frame is showing the pre-typing view. */
  showingHome: boolean;
  /** True when the root query is being interpreted as a direct Spotify reference. */
  showingReference: boolean;

  configure: (client: SpotifyClient, market: string | undefined, meId: string) => void;
  openPalette: () => void;
  /** Open straight into an album, artist or playlist, skipping the search prompt. */
  openAt: (target: Drill) => void;
  closePalette: () => void;
  /** Types into whichever frame is on top: a search query at the root, a filter when drilled. */
  setQuery: (query: string) => void;
  /** Change the visible Spotify result scope; the query itself remains untouched. */
  setScope: (scope: SearchScope) => void;
  /** Move the highlight within the list. */
  move: (delta: number) => void;
  /** Move by one rendered viewport, including non-selectable headers. */
  movePage: (direction: -1 | 1, pageSize: number) => void;
  moveTo: (edge: "first" | "last") => void;
  loadMore: (category: SearchCategory) => void;
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
  currentRow: () => SelectableRow | null;
}

let client: SpotifyClient | null = null;
let market: string | undefined;
/** Spotify id of the signed-in user; only their own playlists can be opened. */
let meId = "";
let debounce: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;
const pageLoads = new Map<SearchCategory, AbortController>();
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
 * Highlighting on arrival makes arrow-key selection useful immediately while the query remains
 * focused for uninterrupted typing.
 */
const frameOf = (
  rows: Row[],
  title?: string,
  searchSource?: { query: string; scope: SearchScope; results: SearchResults },
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
  searchSource?: { query: string; scope: SearchScope; results: SearchResults },
): Frame {
  const selected = root.rows[root.selected];
  if (selected?.kind === "more") {
    const next = frameOf(rows, root.title, searchSource);
    const sameMore = next.rows.findIndex(
      (row) => row.kind === "more" && row.category === selected.category,
    );
    if (sameMore !== -1) return { ...next, selected: sameMore };
    const sameIndex = next.rows[root.selected];
    return isSelectable(sameIndex)
      ? { ...next, selected: root.selected }
      : next;
  }
  const key = selected?.kind === "result" ? resultKey(selected) : null;
  const next = frameOf(rows, root.title, searchSource);
  if (key === null) return next;

  const selectedIndex = next.rows.findIndex(
    (row) => row.kind === "result" && resultKey(row) === key,
  );
  return selectedIndex === -1 ? next : { ...next, selected: selectedIndex };
}

function cancelPending(): void {
  if (debounce !== null) clearTimeout(debounce);
  debounce = null;
  inFlight?.abort();
  inFlight = null;
  for (const controller of pageLoads.values()) controller.abort();
  pageLoads.clear();
}

function appendUnique<T extends { uri: string }>(current: T[], next: T[]): T[] {
  const uris = new Set(current.map((item) => item.uri));
  return [...current, ...next.filter((item) => !uris.has(item.uri))];
}

function appendPage(
  current: SearchResults,
  next: SearchResults,
  category: SearchCategory,
): SearchResults {
  const currentPage = current.pages?.[category];
  const nextPage = next.pages?.[category];
  if (currentPage === undefined) return current;
  if (nextPage === undefined) {
    // Spotify can legitimately answer a follow-up search with 204. There is nothing to append in
    // that case, but the category is complete: retaining the in-flight page state would leave its
    // action row permanently disabled even though the request itself has finished.
    return {
      ...current,
      pages: {
        ...current.pages,
        [category]: {
          ...currentPage,
          nextOffset: null,
          loadingMore: false,
          loadMoreError: undefined,
        },
      },
    };
  }

  const merged: SearchResults = {
    ...current,
    pages: { ...current.pages },
  };
  let loaded: number;
  switch (category) {
    case "tracks":
      merged.tracks = appendUnique(current.tracks, next.tracks);
      loaded = merged.tracks.length;
      break;
    case "artists":
      merged.artists = appendUnique(current.artists, next.artists);
      loaded = merged.artists.length;
      break;
    case "albums":
      merged.albums = appendUnique(current.albums, next.albums);
      loaded = merged.albums.length;
      break;
    case "playlists":
      merged.playlists = appendUnique(current.playlists, next.playlists);
      loaded = merged.playlists.length;
      break;
  }
  merged.pages = {
    ...merged.pages,
    [category]: {
      loaded,
      total: Math.max(nextPage.total, loaded),
      nextOffset: nextPage.nextOffset,
    },
  };
  return merged;
}

/** Local playlist matches belong only in searches whose explicit semantics include playlists. */
function contextForSearch(query: string, scope: SearchScope) {
  return {
    meId,
    libraryMatches:
      eligibleSearchTypes(scope, query).includes("playlist")
        ? matchPlaylists(home.playlists, query)
        : [],
  };
}

export const useSearch = create<SearchSlice>((set, get) => ({
  open: false,
  query: "",
  scope: "all",
  frames: [frameOf([])],
  error: null,
  showingHome: true,
  showingReference: false,

  configure(nextClient, nextMarket, nextMeId) {
    usePlaylistCatalog.getState().configure(nextClient, nextMeId);
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
        scope: "all",
        frames: [frameOf([])],
        error: null,
        showingHome: true,
        showingReference: false,
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
      scope: "all",
      frames: [frameOf(toHomeRows(home))],
      error: null,
      showingHome: true,
      showingReference: false,
    });

    if (home !== EMPTY_HOME || client === null) return;

    set({ frames: [loadingFrame()] });
    const controller = new AbortController();
    homeLoad = controller;

    void (async () => {
      try {
        const data = await fetchHome(client, {
          market,
          meId,
          signal: controller.signal,
          loadPlaylists: () => usePlaylistCatalog.getState().load("background"),
        });
        if (controller.signal.aborted) return;
        home = data;
        const { frames, query, scope } = get();

        // Fill the root even when a drilled frame currently owns the screen. Only the first frame
        // changes, so the active drill and its loading state remain untouched while Back is made
        // ready with the newly loaded library.
        if (query.trim().length === 0) {
          set({
            frames: [frameOf(toHomeRows(data)), ...frames.slice(1)],
            showingHome: true,
            showingReference: false,
          });
          return;
        }

        // Search may have completed while the playlist library was still loading. Rebuild that
        // frame from its source response so owned playlist-name matches appear without another
        // network search or an extra keystroke. If search is still loading, it will use `home`
        // itself when its response arrives.
        const root = frames[0];
        if (root?.search?.query === query && root.search.scope === scope) {
          const context = contextForSearch(query, root.search.scope);
          set({
            frames: [
              replaceRootRows(root, toRows(root.search.results, context), root.search),
              ...frames.slice(1),
            ],
            showingHome: false,
            showingReference: false,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        set({
          frames: withTop(get().frames, { loading: false }),
          error: failureMessage("load your library", err),
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
    set({
      open: false,
      query: "",
      scope: "all",
      frames: [frameOf([])],
      error: null,
      showingHome: true,
      showingReference: false,
    });
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
      set({
        frames: [frameOf(toHomeRows(home))],
        showingHome: true,
        showingReference: false,
        error: null,
      });
      return;
    }

    const reference = parseSpotifyReference(text);
    if (reference !== null) {
      set({ frames: [loadingFrame()], showingHome: false, showingReference: true, error: null });
      if (!supportsSpotifyReference(reference)) {
        set({
          frames: [frameOf([])],
          error: failureMessage(
            "load this item",
            new Error(`${reference.type} links are not supported yet`),
          ),
        });
        return;
      }
      if (client === null) return;

      const controller = new AbortController();
      inFlight = controller;
      void resolveSpotifyReference(client, reference, {
        market,
        signal: controller.signal,
      })
        .then((resolved) => {
          if (controller.signal.aborted || get().query !== text) return;
          set({
            frames: [
              frameOf(
                toReferenceRows(resolved, {
                  meId,
                  libraryMatches: [],
                }),
              ),
            ],
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          set({
            frames: [frameOf([])],
            error: failureMessage("load this item", err),
          });
        })
        .finally(() => {
          if (inFlight === controller) inFlight = null;
        });
      return;
    }

    if (looksLikeSpotifyReference(text)) {
      set({
        frames: [frameOf([])],
        showingHome: false,
        showingReference: true,
        error: null,
      });
      return;
    }

    // Clear the old rows immediately. Leaving them up means the highlight sits on a row that no
    // longer matches what is on screen, which is how a home track once played mid-search.
    set({
      frames: [loadingFrame()],
      showingHome: false,
      showingReference: false,
      error: null,
    });

    debounce = setTimeout(() => {
      debounce = null;
      if (client === null) return;

      const controller = new AbortController();
      inFlight = controller;
      const requestedScope = get().scope;

      void (async () => {
        try {
          const results = await search(client, text, {
            market,
            signal: controller.signal,
            scope: requestedScope,
          });
          // A newer keystroke may have superseded this request while it was in flight.
          if (
            controller.signal.aborted ||
            get().query !== text ||
            get().scope !== requestedScope
          ) {
            return;
          }
          const context = contextForSearch(text, requestedScope);
          set({
            frames: [
              frameOf(toRows(results, context), undefined, {
                query: text,
                scope: requestedScope,
                results,
              }),
            ],
            showingHome: false,
            showingReference: false,
            error: null,
          });
        } catch (err) {
          if (controller.signal.aborted) return;
          set({
            frames: withTop(get().frames, { loading: false }),
            error: failureMessage("search", err),
          });
        } finally {
          if (inFlight === controller) inFlight = null;
        }
      })();
    }, DEBOUNCE_MS);
  },

  setScope(nextScope) {
    const state = get();
    if (state.frames.length > 1 || state.showingReference || state.scope === nextScope) return;
    set({ scope: nextScope, error: null });
    if (state.query.trim().length > 0 && parseSpotifyReference(state.query) === null) {
      get().setQuery(state.query);
    }
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

  movePage(direction, pageSize) {
    const top = topOf(get().frames);
    if (top === undefined) return;
    const visible = filterRows(top.rows, top.filter);
    if (visible.length === 0) return;
    set({
      frames: withTop(get().frames, {
        selected: moveSelectionPage(visible, top.selected, direction, pageSize),
      }),
    });
  },

  moveTo(edge) {
    const top = topOf(get().frames);
    if (top === undefined) return;
    const visible = filterRows(top.rows, top.filter);
    const selectable = visible
      .map((row, index) => (isSelectable(row) ? index : -1))
      .filter((index) => index !== -1);
    const selected = edge === "first" ? selectable[0] : selectable.at(-1);
    if (selected === undefined) return;
    set({ frames: withTop(get().frames, { selected }) });
  },

  loadMore(category) {
    if (client === null || pageLoads.has(category)) return;
    const root = get().frames[0];
    const source = root?.search;
    const page = source?.results.pages?.[category];
    if (root === undefined || source === undefined || page?.nextOffset === null || page === undefined) {
      return;
    }

    const controller = new AbortController();
    pageLoads.set(category, controller);
    const loadingResults: SearchResults = {
      ...source.results,
      pages: {
        ...source.results.pages,
        [category]: { ...page, loadingMore: true, loadMoreError: undefined },
      },
    };
    const loadingSource = { ...source, results: loadingResults };
    const context = contextForSearch(source.query, source.scope);
    set({
      frames: [
        replaceRootRows(root, toRows(loadingResults, context), loadingSource),
        ...get().frames.slice(1),
      ],
      error: null,
    });

    void (async () => {
      try {
        const next = await search(client, source.query, {
          market,
          signal: controller.signal,
          scope: scopeForCategory(category),
          offset: page.nextOffset ?? undefined,
        });
        if (controller.signal.aborted) return;
        const latestRoot = get().frames[0];
        const latestSource = latestRoot?.search;
        if (
          latestRoot === undefined ||
          latestSource?.query !== source.query ||
          latestSource.scope !== source.scope
        ) {
          return;
        }
        const merged = appendPage(latestSource.results, next, category);
        const mergedSource = { ...latestSource, results: merged };
        const latestContext = contextForSearch(latestSource.query, latestSource.scope);
        let replacement = replaceRootRows(
          latestRoot,
          toRows(merged, latestContext),
          mergedSource,
        );
        const selectedBeforeMerge = latestRoot.rows[latestRoot.selected];
        if (
          selectedBeforeMerge?.kind === "more" &&
          selectedBeforeMerge.category === category &&
          isSelectable(replacement.rows[latestRoot.selected])
        ) {
          // The former action row's position is now the first newly appended result. Landing there
          // makes the added page immediately useful instead of jumping past it to the next action.
          replacement = { ...replacement, selected: latestRoot.selected };
        }
        set({
          frames: [
            replacement,
            ...get().frames.slice(1),
          ],
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        const latestRoot = get().frames[0];
        const latestSource = latestRoot?.search;
        const latestPage = latestSource?.results.pages?.[category];
        if (latestRoot === undefined || latestSource === undefined || latestPage === undefined) return;
        const failed: SearchResults = {
          ...latestSource.results,
          pages: {
            ...latestSource.results.pages,
            [category]: {
              ...latestPage,
              loadingMore: false,
              loadMoreError: failureMessage("load more", err),
            },
          },
        };
        const failedSource = { ...latestSource, results: failed };
        const latestContext = contextForSearch(latestSource.query, latestSource.scope);
        set({
          frames: [
            replaceRootRows(latestRoot, toRows(failed, latestContext), failedSource),
            ...get().frames.slice(1),
          ],
        });
      } finally {
        if (pageLoads.get(category) === controller) pageLoads.delete(category);
      }
    })();
  },

  drillInto(target) {
    if (client === null) return;

    drillLoad?.abort();
    const controller = new AbortController();
    drillLoad = controller;

    set({
      frames: [...get().frames, loadingFrame(target.name)],
      error: null,
    });

    void (async () => {
      try {
        const rows = await rowsForDrill(client, target, {
          market,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        set({
          frames: withTop(get().frames, { rows, selected: firstSelectable(rows), loading: false }),
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        set({
          frames: withTop(get().frames, { loading: false }),
          error: failureMessage("load this item", err),
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
      set({
        frames: [frameOf(toHomeRows(home))],
        showingHome: true,
        showingReference: false,
        error: null,
      });
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
    const row = get().currentRow();
    return row?.kind === "result" ? row : null;
  },

  currentRow() {
    const rows = get().rows();
    const row = rows[get().selected()];
    return isSelectable(row) ? row : null;
  },
}));
