/** Subset of Spotify's models that the UI actually reads. */

export interface Image {
  url: string;
  width: number | null;
  height: number | null;
}

export interface SimpleArtist {
  id: string;
  name: string;
  uri: string;
}

export interface SimpleAlbum {
  id: string;
  name: string;
  uri: string;
  images: Image[];
  artists?: SimpleArtist[];
  release_date?: string;
  total_tracks?: number;
}

export interface Track {
  id: string | null;
  name: string;
  uri: string;
  duration_ms: number;
  artists: SimpleArtist[];
  album: SimpleAlbum;
  is_local?: boolean;
}

export interface Episode {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  show?: { id: string; name: string };
  release_date?: string;
}

/** An artist with the audience fields the full artist object carries and the simple one omits. */
export interface FullArtist extends SimpleArtist {
  genres?: string[];
  followers?: { total: number };
  images?: Image[];
}

export interface SimpleShow {
  id: string;
  name: string;
  uri: string;
  publisher?: string;
  description?: string;
  total_episodes?: number;
}

export interface SimpleAudiobook {
  id: string;
  name: string;
  uri: string;
  authors?: { name: string }[];
  publisher?: string;
  description?: string;
  total_chapters?: number;
}

export type PlayableItem = Track | Episode;

export function isTrack(item: PlayableItem): item is Track {
  return "album" in item;
}

/** Best-effort display line for either a track or a podcast episode. */
export function artistLine(item: PlayableItem): string {
  if (isTrack(item)) return item.artists.map((a) => a.name).join(", ");
  return item.show?.name ?? "";
}

export interface Device {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume?: boolean;
}

export type RepeatState = "off" | "track" | "context";

export interface PlaybackContext {
  type: "album" | "artist" | "playlist" | "show";
  uri: string;
}

export interface PlaybackState {
  device: Device | null;
  repeat_state: RepeatState;
  shuffle_state: boolean;
  context: PlaybackContext | null;
  progress_ms: number | null;
  is_playing: boolean;
  item: PlayableItem | null;
  currently_playing_type: "track" | "episode" | "ad" | "unknown";
}

export interface Me {
  id: string;
  display_name: string | null;
  /** Only present when the token carries `user-read-private`. */
  product?: string;
  country?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
}
