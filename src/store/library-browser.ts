import { create } from "zustand";
import type { SpotifyClient } from "../api/client.ts";
import { followedArtists } from "../api/follow.ts";
import { savedAlbums } from "../api/library.ts";
import { rowsForDrill } from "./drill.ts";
import { failureMessage } from "./error.ts";
import { usePlaylistCatalog } from "./playlists.ts";
import {
  filterRows,
  firstSelectable,
  isSelectable,
  moveSelection,
  moveSelectionPage,
  toLibraryAlbumRows,
  toLibraryArtistRows,
  toLibraryPlaylistRows,
  type Drill,
  type Row,
} from "./rows.ts";

export const LIBRARY_SECTIONS = ["playlists", "albums", "artists"] as const;
export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];

export const LIBRARY_SECTION_LABEL: Record<LibrarySection, string> = {
  playlists: "PLAYLISTS",
  albums: "ALBUMS",
  artists: "ARTISTS",
};

interface LibraryFrame {
  id: number;
  rows: Row[];
  selected: number;
  filter: string;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  title?: string;
  target?: Drill;
}

type LibraryRoots = Record<LibrarySection, LibraryFrame>;

export interface LibraryBrowserSlice {
  open: boolean;
  section: LibrarySection;
  roots: LibraryRoots;
  drills: LibraryFrame[];

  configure: (client: SpotifyClient, market: string | undefined, meId: string) => void;
  openLibrary: () => void;
  closeLibrary: () => void;
  setSection: (section: LibrarySection) => void;
  cycleSection: (delta: -1 | 1) => void;
  setQuery: (query: string) => void;
  move: (delta: number) => void;
  movePage: (direction: -1 | 1, pageSize: number) => void;
  moveTo: (edge: "first" | "last") => void;
  drillInto: (target: Drill) => void;
  retry: () => void;
  back: () => boolean;

  rows: () => Row[];
  selected: () => number;
  text: () => string;
  loading: () => boolean;
  loaded: () => boolean;
  error: () => string | null;
  depth: () => number;
  breadcrumb: () => string | null;
  total: () => number;
  current: () => Extract<Row, { kind: "result" }> | null;
}

let client: SpotifyClient | null = null;
let market: string | undefined;
let meId = "";
let generation = 0;
let nextFrameId = 1;
let drillLoad: AbortController | null = null;
const rootLoads = new Map<LibrarySection, Promise<void>>();
const rootControllers = new Map<LibrarySection, AbortController>();

function emptyFrame(id = 0): LibraryFrame {
  return {
    id,
    rows: [],
    selected: -1,
    filter: "",
    loading: false,
    loaded: false,
    error: null,
  };
}

function emptyRoots(): LibraryRoots {
  return {
    playlists: emptyFrame(),
    albums: emptyFrame(),
    artists: emptyFrame(),
  };
}

function activeFrame(state: LibraryBrowserSlice): LibraryFrame {
  return state.drills.at(-1) ?? state.roots[state.section];
}

function resultCount(rows: readonly Row[]): number {
  return rows.reduce((count, row) => count + (row.kind === "result" ? 1 : 0), 0);
}

function selectedReference(frame: LibraryFrame): string | null {
  const row = filterRows(frame.rows, frame.filter)[frame.selected];
  return row?.kind === "result" ? row.referenceUri : null;
}

function frameWithRows(frame: LibraryFrame, rows: Row[]): LibraryFrame {
  const reference = selectedReference(frame);
  const visible = filterRows(rows, frame.filter);
  const same = reference === null
    ? -1
    : visible.findIndex((row) => row.kind === "result" && row.referenceUri === reference);
  return {
    ...frame,
    rows,
    selected: same === -1 ? firstSelectable(visible) : same,
    loading: false,
    loaded: true,
    error: null,
  };
}

function cancelAll(): void {
  drillLoad?.abort();
  drillLoad = null;
  for (const controller of rootControllers.values()) controller.abort();
  rootControllers.clear();
  rootLoads.clear();
}

export const useLibraryBrowser = create<LibraryBrowserSlice>((set, get) => {
  const patchRoot = (section: LibrarySection, patch: Partial<LibraryFrame>) => {
    set((state) => ({
      roots: {
        ...state.roots,
        [section]: { ...state.roots[section], ...patch },
      },
    }));
  };

  const loadRoot = (section: LibrarySection, force = false): Promise<void> => {
    const existing = rootLoads.get(section);
    if (existing !== undefined) return existing;
    if (get().roots[section].loaded && !force) return Promise.resolve();
    if (client === null || meId === "") return Promise.resolve();

    const requestClient = client;
    const requestMarket = market;
    const requestGeneration = generation;
    const controller = new AbortController();
    rootControllers.set(section, controller);
    patchRoot(section, { loading: true, error: null });

    let request: Promise<void>;
    request = (async () => {
      try {
        const rows = await (async (): Promise<Row[]> => {
          switch (section) {
            case "playlists": {
              const playlists = await usePlaylistCatalog.getState().load("foreground", force);
              return toLibraryPlaylistRows(playlists);
            }
            case "albums": {
              const albums = await savedAlbums(requestClient, {
                market: requestMarket,
                signal: controller.signal,
                priority: "foreground",
              });
              return toLibraryAlbumRows(albums);
            }
            case "artists": {
              const artists = await followedArtists(requestClient, {
                signal: controller.signal,
                priority: "foreground",
              });
              return toLibraryArtistRows(artists);
            }
          }
        })();
        if (controller.signal.aborted || generation !== requestGeneration) return;
        set((state) => ({
          roots: {
            ...state.roots,
            [section]: frameWithRows(state.roots[section], rows),
          },
        }));
      } catch (error) {
        if (controller.signal.aborted || generation !== requestGeneration) return;
        patchRoot(section, {
          loading: false,
          error: failureMessage(`load ${section}`, error),
        });
      } finally {
        if (rootControllers.get(section) === controller) {
          rootControllers.delete(section);
          rootLoads.delete(section);
        }
      }
    })();
    rootLoads.set(section, request);
    return request;
  };

  const loadDrill = (target: Drill, frameId: number) => {
    if (client === null) return;
    drillLoad?.abort();
    const controller = new AbortController();
    drillLoad = controller;
    const requestClient = client;
    const requestMarket = market;
    const requestGeneration = generation;

    void rowsForDrill(requestClient, target, {
      market: requestMarket,
      signal: controller.signal,
    })
      .then((rows) => {
        if (controller.signal.aborted || generation !== requestGeneration) return;
        set((state) => {
          const top = state.drills.at(-1);
          if (top?.id !== frameId) return state;
          return {
            drills: [
              ...state.drills.slice(0, -1),
              frameWithRows(top, rows),
            ],
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || generation !== requestGeneration) return;
        set((state) => {
          const top = state.drills.at(-1);
          if (top?.id !== frameId) return state;
          return {
            drills: [
              ...state.drills.slice(0, -1),
              {
                ...top,
                loading: false,
                error: failureMessage("open this item", error),
              },
            ],
          };
        });
      })
      .finally(() => {
        if (drillLoad === controller) drillLoad = null;
      });
  };

  return {
    open: false,
    section: "playlists",
    roots: emptyRoots(),
    drills: [],

    configure(nextClient, nextMarket, nextMeId) {
      usePlaylistCatalog.getState().configure(nextClient, nextMeId);
      if (client !== nextClient || market !== nextMarket || meId !== nextMeId) {
        generation++;
        cancelAll();
        set({
          open: false,
          section: "playlists",
          roots: emptyRoots(),
          drills: [],
        });
      }
      client = nextClient;
      market = nextMarket;
      meId = nextMeId;
    },

    openLibrary() {
      const current = get().roots;
      const reset = (frame: LibraryFrame): LibraryFrame => ({
        ...frame,
        filter: "",
        selected: firstSelectable(frame.rows),
        error: null,
      });
      const roots: LibraryRoots = {
        playlists: reset(current.playlists),
        albums: reset(current.albums),
        artists: reset(current.artists),
      };
      set({ open: true, section: "playlists", roots, drills: [] });
      void loadRoot("playlists");
    },

    closeLibrary() {
      drillLoad?.abort();
      drillLoad = null;
      set({ open: false, drills: [] });
    },

    setSection(section) {
      const state = get();
      if (state.drills.length > 0 || state.section === section) return;
      set({ section });
      void loadRoot(section);
    },

    cycleSection(delta) {
      const state = get();
      if (state.drills.length > 0) return;
      const current = LIBRARY_SECTIONS.indexOf(state.section);
      const next = (current + delta + LIBRARY_SECTIONS.length) % LIBRARY_SECTIONS.length;
      const section = LIBRARY_SECTIONS[next];
      if (section !== undefined) get().setSection(section);
    },

    setQuery(query) {
      const state = get();
      const frame = activeFrame(state);
      const selected = firstSelectable(filterRows(frame.rows, query));
      if (state.drills.length === 0) {
        patchRoot(state.section, { filter: query, selected });
        return;
      }
      set({
        drills: [
          ...state.drills.slice(0, -1),
          { ...frame, filter: query, selected },
        ],
      });
    },

    move(delta) {
      const state = get();
      const frame = activeFrame(state);
      const rows = filterRows(frame.rows, frame.filter);
      if (rows.length === 0) return;
      const selected = moveSelection(rows, frame.selected, delta);
      if (state.drills.length === 0) patchRoot(state.section, { selected });
      else set({ drills: [...state.drills.slice(0, -1), { ...frame, selected }] });
    },

    movePage(direction, pageSize) {
      const state = get();
      const frame = activeFrame(state);
      const rows = filterRows(frame.rows, frame.filter);
      if (rows.length === 0) return;
      const selected = moveSelectionPage(rows, frame.selected, direction, pageSize);
      if (state.drills.length === 0) patchRoot(state.section, { selected });
      else set({ drills: [...state.drills.slice(0, -1), { ...frame, selected }] });
    },

    moveTo(edge) {
      const state = get();
      const frame = activeFrame(state);
      const rows = filterRows(frame.rows, frame.filter);
      const selected = edge === "first"
        ? firstSelectable(rows)
        : rows.findLastIndex(isSelectable);
      if (selected < 0) return;
      if (state.drills.length === 0) patchRoot(state.section, { selected });
      else set({ drills: [...state.drills.slice(0, -1), { ...frame, selected }] });
    },

    drillInto(target) {
      if (client === null) return;
      const id = nextFrameId++;
      const frame: LibraryFrame = {
        ...emptyFrame(id),
        title: target.name,
        target,
        loading: true,
      };
      set((state) => ({ drills: [...state.drills, frame] }));
      loadDrill(target, id);
    },

    retry() {
      const state = get();
      const top = state.drills.at(-1);
      if (top?.target !== undefined) {
        set({
          drills: [
            ...state.drills.slice(0, -1),
            { ...top, rows: [], selected: -1, loading: true, error: null },
          ],
        });
        loadDrill(top.target, top.id);
        return;
      }
      void loadRoot(state.section, true);
    },

    back() {
      const state = get();
      if (state.drills.length === 0) return false;
      drillLoad?.abort();
      drillLoad = null;
      set({ drills: state.drills.slice(0, -1) });
      return true;
    },

    rows() {
      const frame = activeFrame(get());
      return filterRows(frame.rows, frame.filter);
    },
    selected: () => activeFrame(get()).selected,
    text: () => activeFrame(get()).filter,
    loading: () => activeFrame(get()).loading,
    loaded: () => activeFrame(get()).loaded,
    error: () => activeFrame(get()).error,
    depth: () => get().drills.length + 1,
    breadcrumb: () => activeFrame(get()).title ?? null,
    total: () => resultCount(activeFrame(get()).rows),
    current() {
      const state = get();
      const frame = activeFrame(state);
      const row = filterRows(frame.rows, frame.filter)[frame.selected];
      return row?.kind === "result" ? row : null;
    },
  };
});
