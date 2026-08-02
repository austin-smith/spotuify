export type SpotifyReferenceType =
  | "track"
  | "artist"
  | "album"
  | "playlist"
  | "episode"
  | "show"
  | "audiobook";

export interface SpotifyReference {
  type: SpotifyReferenceType;
  id: string;
  uri: string;
  url: string;
}

const TYPES: readonly SpotifyReferenceType[] = [
  "track",
  "artist",
  "album",
  "playlist",
  "episode",
  "show",
  "audiobook",
];
const TYPE_PATTERN = TYPES.join("|");
const ID_PATTERN = "[A-Za-z0-9]{22}";
const URI = new RegExp(`^spotify:(${TYPE_PATTERN}):(${ID_PATTERN})$`, "i");

function reference(type: string, id: string): SpotifyReference | null {
  const normalizedType = type.toLowerCase() as SpotifyReferenceType;
  if (!TYPES.includes(normalizedType) || !new RegExp(`^${ID_PATTERN}$`).test(id)) return null;
  return {
    type: normalizedType,
    id,
    uri: `spotify:${normalizedType}:${id}`,
    url: `https://open.spotify.com/${normalizedType}/${id}`,
  };
}

/**
 * Parse a complete Spotify URI or open.spotify.com share URL.
 *
 * Matching the entire trimmed value is intentional: arbitrary text containing a URL remains a
 * search query, and look-alike hosts never become privileged navigation intents.
 */
export function parseSpotifyReference(value: string): SpotifyReference | null {
  const trimmed = value.trim();
  const uri = URI.exec(trimmed);
  if (uri !== null) return reference(uri[1] ?? "", uri[2] ?? "");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "open.spotify.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  // Spotify localizes some share URLs with an `/intl-xx/` path prefix.
  if (segments[0]?.toLowerCase().startsWith("intl-") === true) segments.shift();
  if (segments.length !== 2) return null;
  return reference(segments[0] ?? "", segments[1] ?? "");
}

/** Avoid firing ordinary search requests while a Spotify reference is still being pasted/typed. */
export function looksLikeSpotifyReference(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("spotify:") || trimmed.startsWith("https://open.spotify.com/");
}

export function spotifyOpenUrl(uri: string): string | null {
  return parseSpotifyReference(uri)?.url ?? null;
}
