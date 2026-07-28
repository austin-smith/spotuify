import { create } from "zustand";
import { isTrack, type PlayableItem } from "../api/types.ts";
import type { Drill } from "./rows.ts";

/**
 * One line in the actions menu.
 *
 * Every entry is somewhere to go, so the whole menu reduces to a `Drill` the palette already knows
 * how to open. Verbs that act on the track rather than navigate to it belong here too, but each one
 * needs its own endpoint verified first.
 */
export interface ActionEntry {
  label: string;
  detail: string;
  drill: Drill;
}

export interface ActionsSlice {
  open: boolean;
  entries: ActionEntry[];
  selected: number;

  openActions: (item: PlayableItem) => void;
  closeActions: () => void;
  move: (delta: number) => void;
  current: () => ActionEntry | null;
}

/**
 * Where you can go from a track: its album, then each of its artists.
 *
 * Collaborations get one line per artist rather than silently picking the first. Local files carry
 * no catalog ids, so they yield nothing and the menu stays shut.
 */
export function entriesFor(item: PlayableItem): ActionEntry[] {
  if (!isTrack(item)) return [];

  const entries: ActionEntry[] = [];

  if (item.album.id !== "") {
    entries.push({
      label: "go to album",
      detail: item.album.name,
      drill: { kind: "album", id: item.album.id, name: item.album.name, uri: item.album.uri },
    });
  }

  for (const artist of item.artists) {
    if (artist.id === "") continue;
    entries.push({
      label: "go to artist",
      detail: artist.name,
      drill: { kind: "artist", id: artist.id, name: artist.name },
    });
  }

  return entries;
}

/**
 * Actions on the playing track.
 *
 * A menu rather than a key per destination: album and artist are two of many verbs a track will
 * eventually have, and binding each to its own letter is how a keymap becomes unlearnable. This is
 * the pattern spotify-player settled on.
 */
export const useActions = create<ActionsSlice>((set, get) => ({
  open: false,
  entries: [],
  selected: 0,

  openActions(item) {
    const entries = entriesFor(item);
    // Nothing to offer means nothing to show; an empty menu is worse than an ignored keypress.
    if (entries.length === 0) return;
    set({ open: true, entries, selected: 0 });
  },

  closeActions() {
    set({ open: false, entries: [], selected: 0 });
  },

  move(delta) {
    const { entries, selected } = get();
    if (entries.length === 0) return;
    set({ selected: Math.min(entries.length - 1, Math.max(0, selected + (delta > 0 ? 1 : -1))) });
  },

  current() {
    const { entries, selected } = get();
    return entries[selected] ?? null;
  },
}));
