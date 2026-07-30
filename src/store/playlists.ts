import { create } from "zustand";
import type { SpotifyClient } from "../api/client.ts";
import { myPlaylists, type Playlist } from "../api/playlists.ts";

export interface PlaylistCatalogSlice {
  playlists: Playlist[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  /** Bind the cache to one authenticated Spotify account. */
  configure: (client: SpotifyClient, meId: string) => void;
  /**
   * Load every library playlist once for this account.
   *
   * Concurrent consumers share the same promise. The request is deliberately not tied to a modal's
   * AbortSignal: closing search must not cancel a catalog load the playlist picker is also awaiting.
   */
  load: (
    priority?: "foreground" | "background",
    /** Refresh even when this account already has a completed snapshot. */
    force?: boolean,
  ) => Promise<Playlist[]>;
}

let client: SpotifyClient | null = null;
let meId = "";
let generation = 0;
let pending: Promise<Playlist[]> | null = null;

export const usePlaylistCatalog = create<PlaylistCatalogSlice>((set, get) => ({
  playlists: [],
  loaded: false,
  loading: false,
  error: null,

  configure(nextClient, nextMeId) {
    if (client !== nextClient || meId !== nextMeId) {
      generation++;
      pending = null;
      set({ playlists: [], loaded: false, loading: false, error: null });
    }
    client = nextClient;
    meId = nextMeId;
  },

  async load(priority = "background", force = false) {
    if (pending !== null) return await pending;
    if (get().loaded && !force) return get().playlists;
    if (client === null || meId === "") return [];

    const requestClient = client;
    const requestMeId = meId;
    const requestGeneration = generation;
    set({ loading: true, error: null });

    let request: Promise<Playlist[]>;
    request = myPlaylists(requestClient, requestMeId, { priority })
      .then((playlists) => {
        if (generation === requestGeneration) {
          set({ playlists, loaded: true, loading: false, error: null });
        }
        return playlists;
      })
      .catch((error: unknown) => {
        if (generation === requestGeneration) {
          set({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      })
      .finally(() => {
        if (generation === requestGeneration && pending === request) pending = null;
      });
    pending = request;
    return await request;
  },
}));
