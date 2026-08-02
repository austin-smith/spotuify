import { create } from "zustand";
import {
  SpotifyApiError,
  SpotifyLimitError,
  type SpotifyClient,
} from "../api/client.ts";
import {
  libraryContains,
  removeLibraryItems,
  saveLibraryItems,
} from "../api/library.ts";
import { addPlaylistItems, type Playlist } from "../api/playlists.ts";
import { isTrack, type PlayableItem } from "../api/types.ts";
import type { Drill } from "./rows.ts";
import { usePlaylistCatalog } from "./playlists.ts";

export type ActionOrigin = "playback" | "palette";
export type ActionMode = "actions" | "playlists";

export type ActionEntry =
  | {
      id: string;
      kind: "drill";
      label: string;
      detail: string;
      disabled: false;
      drill: Drill;
    }
  | {
      id: "add-to-playlist";
      kind: "playlist";
      label: string;
      detail: string;
      disabled: false;
    }
  | {
      id: "library";
      kind: "library";
      label: string;
      detail: string;
      disabled: false;
      saved: boolean;
    }
  | {
      id: "library-loading";
      kind: "library-loading";
      label: string;
      detail: string;
      disabled: true;
    }
  | {
      id: "library-retry";
      kind: "library-retry";
      label: string;
      detail: string;
      disabled: false;
    };

export interface ActionNotice {
  kind: "success" | "error";
  message: string;
}

export type ActionResult = {
  kind: "drill";
  drill: Drill;
  origin: ActionOrigin;
};

export interface ActionsSlice {
  open: boolean;
  mode: ActionMode;
  target: PlayableItem | null;
  origin: ActionOrigin;
  entries: ActionEntry[];
  selected: number;
  savedLoading: boolean;
  busy: boolean;
  error: string | null;
  notice: ActionNotice | null;

  playlists: Playlist[];
  playlistsLoading: boolean;
  playlistQuery: string;
  playlistSelected: number;

  configure: (client: SpotifyClient, meId: string) => void;
  openActions: (item: PlayableItem, origin?: ActionOrigin) => void;
  closeActions: () => void;
  /** Return from the playlist picker to its action list. */
  back: () => void;
  move: (delta: number) => void;
  current: () => ActionEntry | null;
  currentPlaylist: () => Playlist | null;
  setPlaylistQuery: (query: string) => void;
  /** Perform the highlighted action. Navigation is returned for App to hand to search. */
  activate: () => Promise<ActionResult | null>;
  /** One-key save/unsave for the currently playing item. */
  toggleSaved: (item: PlayableItem) => Promise<void>;
  /** Publish transient feedback for non-mutating actions such as clipboard copies. */
  notify: (notice: ActionNotice) => void;
  clearNotice: () => void;
}

let client: SpotifyClient | null = null;
let meId = "";
let generation = 0;
let openRevision = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** Membership belongs to one configured account and is only populated on demand. */
const SAVED_CACHE_TTL_MS = 15_000;
const savedByUri = new Map<string, { saved: boolean; checkedAt: number }>();
/** Bumped after every successful mutation so a late read cannot overwrite the new local truth. */
const savedEpochByUri = new Map<string, number>();
const savedReads = new Map<string, Promise<boolean>>();
const writes = new Map<string, symbol>();
const playlistWrites = new Map<string, symbol>();

function isSpotifyLibraryItem(item: PlayableItem): boolean {
  if (isTrack(item) && item.is_local === true) return false;
  return /^spotify:(track|episode):[^:]+$/.test(item.uri);
}

function canAddToPlaylist(item: PlayableItem): boolean {
  if (isTrack(item) && item.is_local === true) return false;
  return /^spotify:(track|episode):[^:]+$/.test(item.uri);
}

function libraryDestination(item: PlayableItem): string {
  return isTrack(item) ? "liked songs" : "your episodes";
}

function entriesFor(
  item: PlayableItem,
  saved: boolean | null,
  savedLoading: boolean,
  savedFailed = false,
): ActionEntry[] {
  const entries: ActionEntry[] = [];

  if (isTrack(item)) {
    if (item.album.id !== "") {
      entries.push({
        id: `album:${item.album.id}`,
        kind: "drill",
        label: "go to album",
        detail: item.album.name,
        disabled: false,
        drill: { kind: "album", id: item.album.id, name: item.album.name, uri: item.album.uri },
      });
    }

    for (const artist of item.artists) {
      if (artist.id === "") continue;
      entries.push({
        id: `artist:${artist.id}`,
        kind: "drill",
        label: "go to artist",
        detail: artist.name,
        disabled: false,
        drill: { kind: "artist", id: artist.id, name: artist.name },
      });
    }
  }

  if (canAddToPlaylist(item)) {
    entries.push({
      id: "add-to-playlist",
      kind: "playlist",
      label: "add to playlist",
      detail: "choose a destination",
      disabled: false,
    });
  }

  if (isSpotifyLibraryItem(item)) {
    if (savedLoading) {
      entries.push({
        id: "library-loading",
        kind: "library-loading",
        label: "checking liked state",
        detail: "",
        disabled: true,
      });
    } else if (savedFailed) {
      entries.push({
        id: "library-retry",
        kind: "library-retry",
        label: "retry liked state",
        detail: "",
        disabled: false,
      });
    } else if (saved !== null) {
      entries.push({
        id: "library",
        kind: "library",
        label: saved
          ? `remove from ${libraryDestination(item)}`
          : `save to ${libraryDestination(item)}`,
        detail: "",
        disabled: false,
        saved,
      });
    }
  }

  return entries;
}

function firstEnabled(entries: readonly ActionEntry[]): number {
  return entries.findIndex((entry) => !entry.disabled);
}

/**
 * Move the selection by `delta` enabled entries, stopping at the ends.
 *
 * Walks the full magnitude rather than one step: the wheel reports multi-row deltas, and reducing
 * them to their sign made this the one list that lagged behind an identical gesture elsewhere.
 */
function moveEnabled(entries: readonly ActionEntry[], selected: number, delta: number): number {
  if (entries.length === 0) return -1;
  const step = delta > 0 ? 1 : -1;
  let remaining = Math.abs(delta);
  let index = selected;

  while (remaining > 0) {
    let next = index + step;
    while (next >= 0 && next < entries.length && entries[next]?.disabled) next += step;
    if (next < 0 || next >= entries.length) break;
    index = next;
    remaining--;
  }

  return index;
}

/** Filter locally; loading the full catalog once is cheaper and more predictable than API search. */
export function filterOwnedPlaylists(playlists: readonly Playlist[], query: string): Playlist[] {
  const needle = query.trim().toLowerCase();
  return playlists.filter(
    (playlist) => playlist.mine && playlist.name.toLowerCase().includes(needle),
  );
}

function message(error: unknown): string {
  if (error instanceof SpotifyLimitError) {
    return error.quotaExceeded
      ? "spotify web api quota exhausted"
      : `spotify is limiting requests: ${error.detail}`;
  }
  if (error instanceof SpotifyApiError) {
    if (error.status === 403) return "spotify denied this change";
    if (error.status === 404) return "that spotify item is no longer available";
    return error.detail;
  }
  return error instanceof Error ? error.message : String(error);
}

function publishNotice(
  set: (patch: Partial<ActionsSlice>) => void,
  notice: ActionNotice,
): void {
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  set({ notice });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    useActions.setState({ notice: null });
  }, 4_000);
}

async function readSaved(item: PlayableItem, force = false): Promise<boolean> {
  if (client === null || !isSpotifyLibraryItem(item)) {
    throw new Error("this item cannot be saved to your spotify library");
  }
  if (force) savedByUri.delete(item.uri);
  const cached = savedByUri.get(item.uri);
  if (cached !== undefined && Date.now() - cached.checkedAt <= SAVED_CACHE_TTL_MS) {
    return cached.saved;
  }

  const existing = savedReads.get(item.uri);
  if (existing !== undefined) return await existing;

  const requestClient = client;
  const requestGeneration = generation;
  const requestEpoch = savedEpochByUri.get(item.uri) ?? 0;
  let request: Promise<boolean>;
  request = libraryContains(requestClient, [item.uri])
    .then(([saved]) => {
      if (saved === undefined) throw new Error("spotify omitted the library membership result");
      if (
        generation === requestGeneration &&
        (savedEpochByUri.get(item.uri) ?? 0) === requestEpoch
      ) {
        savedByUri.set(item.uri, { saved, checkedAt: Date.now() });
      }
      return saved;
    })
    .finally(() => {
      if (savedReads.get(item.uri) === request) savedReads.delete(item.uri);
    });
  savedReads.set(item.uri, request);
  return await request;
}

function resetAccountState(): void {
  generation++;
  openRevision++;
  savedByUri.clear();
  savedEpochByUri.clear();
  savedReads.clear();
  writes.clear();
  playlistWrites.clear();
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = null;
}

export const useActions = create<ActionsSlice>((set, get) => {
  const setNotice = (notice: ActionNotice) => publishNotice(set, notice);

  const applyMembership = (
    item: PlayableItem,
    saved: boolean | null,
    state: { loading?: boolean; failed?: boolean } = {},
  ) => {
    const entries = entriesFor(item, saved, state.loading === true, state.failed === true);
    const current = get().entries[get().selected];
    const sameIndex = current === undefined ? -1 : entries.findIndex((e) => e.id === current.id);
    set({
      entries,
      selected: sameIndex === -1 ? firstEnabled(entries) : sameIndex,
      savedLoading: state.loading === true,
    });
  };

  const resolveOpenMembership = (item: PlayableItem, force = false) => {
    if (!isSpotifyLibraryItem(item)) return;
    const revision = openRevision;
    applyMembership(item, null, { loading: true });
    void readSaved(item, force)
      .then((saved) => {
        const state = get();
        if (
          revision !== openRevision ||
          !state.open ||
          state.target?.uri !== item.uri
        ) {
          return;
        }
        if (state.mode === "actions") set({ error: null });
        applyMembership(item, saved);
      })
      .catch((error: unknown) => {
        const state = get();
        if (
          revision !== openRevision ||
          !state.open ||
          state.target?.uri !== item.uri
        ) {
          return;
        }
        if (state.mode === "actions") set({ error: message(error) });
        applyMembership(item, null, { failed: true });
      });
  };

  const toggle = async (
    item: PlayableItem,
    closeAfter: boolean,
    desiredSaved?: boolean,
  ) => {
    if (client === null) return;
    if (!isSpotifyLibraryItem(item)) {
      setNotice({ kind: "error", message: "this item cannot be saved to liked songs" });
      return;
    }
    if (writes.has(item.uri)) return;
    const requestClient = client;
    const write = Symbol(item.uri);
    writes.set(item.uri, write);
    const requestGeneration = generation;
    if (get().target?.uri === item.uri) set({ busy: true, error: null });

    try {
      // A direct one-key toggle must observe external changes before deciding which verb to issue.
      // Menu actions already name an explicit desired state, so repeating that idempotent PUT or
      // DELETE is safer and cheaper than turning it back into an implicit toggle.
      const next = desiredSaved ?? !(await readSaved(item, true));
      if (generation !== requestGeneration) return;
      if (next) await saveLibraryItems(requestClient, [item.uri]);
      else await removeLibraryItems(requestClient, [item.uri]);
      if (generation !== requestGeneration) return;

      savedEpochByUri.set(item.uri, (savedEpochByUri.get(item.uri) ?? 0) + 1);
      savedByUri.set(item.uri, { saved: next, checkedAt: Date.now() });
      setNotice({
        kind: "success",
        message: next
          ? `saved ${item.name} to ${libraryDestination(item)}`
          : `removed ${item.name} from ${libraryDestination(item)}`,
      });

      if (get().target?.uri === item.uri) {
        if (closeAfter) {
          openRevision++;
          set({
            open: false,
            target: null,
            entries: [],
            selected: -1,
            busy: false,
            error: null,
          });
        } else {
          applyMembership(item, next);
          set({ busy: false, error: null });
        }
      }
    } catch (error) {
      if (generation !== requestGeneration) return;
      const detail = message(error);
      if (get().target?.uri === item.uri && get().open) {
        set({ busy: false, error: detail });
      }
      setNotice({ kind: "error", message: detail });
    } finally {
      if (writes.get(item.uri) === write) {
        writes.delete(item.uri);
        if (get().target?.uri === item.uri) set({ busy: false });
      }
    }
  };

  const openPlaylistPicker = async () => {
    const target = get().target;
    if (target === null || !canAddToPlaylist(target)) return;
    const revision = openRevision;
    const catalog = usePlaylistCatalog.getState();
    const cached = filterOwnedPlaylists(catalog.playlists, "");
    set({
      mode: "playlists",
      playlists: cached,
      playlistsLoading: true,
      playlistQuery: "",
      playlistSelected: cached.length > 0 ? 0 : -1,
      error: null,
    });
    try {
      const playlists = filterOwnedPlaylists(await catalog.load("foreground", true), "");
      const state = get();
      if (
        revision !== openRevision ||
        !state.open ||
        state.mode !== "playlists" ||
        state.target?.uri !== target.uri
      ) {
        return;
      }
      set({
        playlists,
        playlistsLoading: false,
        playlistSelected: playlists.length > 0 ? 0 : -1,
        error: null,
      });
    } catch (error) {
      const state = get();
      if (
        revision !== openRevision ||
        !state.open ||
        state.mode !== "playlists" ||
        state.target?.uri !== target.uri
      ) {
        return;
      }
      set({ playlistsLoading: false, error: message(error) });
    }
  };

  return {
    open: false,
    mode: "actions",
    target: null,
    origin: "playback",
    entries: [],
    selected: -1,
    savedLoading: false,
    busy: false,
    error: null,
    notice: null,
    playlists: [],
    playlistsLoading: false,
    playlistQuery: "",
    playlistSelected: -1,

    configure(nextClient, nextMeId) {
      usePlaylistCatalog.getState().configure(nextClient, nextMeId);
      if (client !== nextClient || meId !== nextMeId) {
        resetAccountState();
        set({
          open: false,
          mode: "actions",
          target: null,
          origin: "playback",
          entries: [],
          selected: -1,
          savedLoading: false,
          busy: false,
          error: null,
          notice: null,
          playlists: [],
          playlistsLoading: false,
          playlistQuery: "",
          playlistSelected: -1,
        });
      }
      client = nextClient;
      meId = nextMeId;
    },

    openActions(item, origin = "playback") {
      if (get().busy) return;
      const cached = savedByUri.get(item.uri);
      const saved =
        cached !== undefined && Date.now() - cached.checkedAt <= SAVED_CACHE_TTL_MS
          ? cached.saved
          : null;
      const entries = entriesFor(item, saved, saved === null && isSpotifyLibraryItem(item));
      if (entries.length === 0) return;
      openRevision++;
      set({
        open: true,
        mode: "actions",
        target: item,
        origin,
        entries,
        selected: firstEnabled(entries),
        savedLoading: saved === null && isSpotifyLibraryItem(item),
        busy: writes.has(item.uri),
        error: null,
        playlists: [],
        playlistsLoading: false,
        playlistQuery: "",
        playlistSelected: -1,
      });
      if (saved === null) resolveOpenMembership(item);
    },

    closeActions() {
      if (get().busy) return;
      openRevision++;
      set({
        open: false,
        mode: "actions",
        target: null,
        entries: [],
        selected: -1,
        savedLoading: false,
        busy: false,
        error: null,
        playlists: [],
        playlistsLoading: false,
        playlistQuery: "",
        playlistSelected: -1,
      });
    },

    back() {
      if (get().busy) return;
      if (get().mode === "playlists") {
        set({
          mode: "actions",
          playlists: [],
          playlistsLoading: false,
          playlistQuery: "",
          playlistSelected: -1,
          error: null,
        });
      } else {
        get().closeActions();
      }
    },

    move(delta) {
      const state = get();
      if (state.mode === "actions") {
        if (state.selected === -1) {
          set({ selected: firstEnabled(state.entries) });
          return;
        }
        set({ selected: moveEnabled(state.entries, state.selected, delta) });
        return;
      }

      const visible = filterOwnedPlaylists(state.playlists, state.playlistQuery);
      if (visible.length === 0) return;
      const step = delta > 0 ? 1 : -1;
      set({
        playlistSelected: Math.min(
          visible.length - 1,
          Math.max(0, state.playlistSelected + step),
        ),
      });
    },

    current() {
      const { entries, selected } = get();
      return entries[selected] ?? null;
    },

    currentPlaylist() {
      const state = get();
      const visible = filterOwnedPlaylists(state.playlists, state.playlistQuery);
      return visible[state.playlistSelected] ?? null;
    },

    setPlaylistQuery(query) {
      if (get().busy) return;
      const visible = filterOwnedPlaylists(get().playlists, query);
      set({ playlistQuery: query, playlistSelected: visible.length > 0 ? 0 : -1 });
    },

    async activate() {
      const state = get();
      if (state.busy) return null;

      if (state.mode === "playlists") {
        const target = state.target;
        const playlist = state.currentPlaylist();
        if (
          client === null ||
          target === null ||
          !canAddToPlaylist(target) ||
          playlist === null ||
          !playlist.mine
        ) {
          return null;
        }

        const requestGeneration = generation;
        const requestRevision = openRevision;
        const requestClient = client;
        const writeKey = `${playlist.id}\u0000${target.uri}`;
        if (playlistWrites.has(writeKey)) return null;
        const write = Symbol(writeKey);
        playlistWrites.set(writeKey, write);
        set({ busy: true, error: null });
        try {
          await addPlaylistItems(requestClient, playlist.id, [target.uri]);
          const current = get();
          if (
            generation !== requestGeneration ||
            openRevision !== requestRevision ||
            !current.open ||
            current.mode !== "playlists" ||
            current.target?.uri !== target.uri
          ) {
            return null;
          }
          setNotice({
            kind: "success",
            message: `added ${target.name} to ${playlist.name}`,
          });
          set({ busy: false });
          get().closeActions();
        } catch (error) {
          const current = get();
          if (
            generation === requestGeneration &&
            openRevision === requestRevision &&
            current.open &&
            current.mode === "playlists" &&
            current.target?.uri === target.uri
          ) {
            const detail = message(error);
            set({ busy: false, error: detail });
            setNotice({ kind: "error", message: detail });
          }
        } finally {
          if (playlistWrites.get(writeKey) === write) {
            playlistWrites.delete(writeKey);
            const current = get();
            if (
              openRevision === requestRevision &&
              current.open &&
              current.mode === "playlists" &&
              current.target?.uri === target.uri
            ) {
              set({ busy: false });
            }
          }
        }
        return null;
      }

      const entry = state.current();
      if (entry === null || entry.disabled || state.target === null) return null;
      switch (entry.kind) {
        case "drill": {
          const result: ActionResult = {
            kind: "drill",
            drill: entry.drill,
            origin: state.origin,
          };
          get().closeActions();
          return result;
        }
        case "playlist":
          await openPlaylistPicker();
          return null;
        case "library":
          await toggle(state.target, true, !entry.saved);
          return null;
        case "library-retry":
          set({ error: null });
          resolveOpenMembership(state.target, true);
          return null;
      }
    },

    async toggleSaved(item) {
      await toggle(item, false);
    },

    notify(notice) {
      setNotice(notice);
    },

    clearNotice() {
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      noticeTimer = null;
      set({ notice: null });
    },
  };
});
