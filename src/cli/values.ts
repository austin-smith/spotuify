import { usageError } from "./errors.ts";

export type SpotifyKind =
  | "album"
  | "artist"
  | "episode"
  | "playlist"
  | "show"
  | "track"
  | "user"
  | "audiobook";

export interface SpotifyReference {
  kind: SpotifyKind;
  id: string;
  uri: string;
}

const KINDS = new Set<SpotifyKind>([
  "album",
  "artist",
  "episode",
  "playlist",
  "show",
  "track",
  "user",
  "audiobook",
]);
const SPOTIFY_ID = /^[A-Za-z0-9]+$/;

export function spotifyReference(
  value: string,
  expected?: SpotifyKind,
): SpotifyReference {
  let kind: string | undefined;
  let id: string | undefined;
  const trimmed = value.trim();

  const uri = /^spotify:([^:]+):([^:?#]+)$/i.exec(trimmed);
  if (uri !== null) [, kind, id] = uri;
  else {
    try {
      const url = new URL(trimmed);
      if (
        url.hostname === "open.spotify.com" ||
        url.hostname.endsWith(".open.spotify.com")
      ) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0]?.startsWith("intl-")) parts.shift();
        if (parts.length === 2) [kind, id] = parts;
      }
    } catch {
      // A bare Spotify ID is accepted when the command already establishes its resource kind.
    }
  }

  if (
    kind === undefined &&
    expected !== undefined &&
    SPOTIFY_ID.test(trimmed)
  ) {
    kind = expected;
    id = trimmed;
  }
  if (
    kind === undefined ||
    id === undefined ||
    !KINDS.has(kind.toLowerCase() as SpotifyKind) ||
    !SPOTIFY_ID.test(id)
  ) {
    throw usageError(`Invalid Spotify URI or URL: ${value}`);
  }
  kind = kind.toLowerCase();
  if (expected !== undefined && kind !== expected) {
    throw usageError(`Expected a Spotify ${expected}, received ${kind}.`);
  }
  return { kind: kind as SpotifyKind, id, uri: `spotify:${kind}:${id}` };
}

export function spotifyUri(value: string): string {
  return spotifyReference(value).uri;
}

/** The kinds Spotify's library endpoints accept, shared by save and remove. */
export const LIBRARY_KINDS = [
  "track",
  "episode",
  "album",
  "show",
  "audiobook",
] as const;

export function libraryUri(item: string, refusal: string): string {
  const ref = spotifyReference(item);
  if (!(LIBRARY_KINDS as readonly string[]).includes(ref.kind)) {
    throw usageError(`Spotify ${ref.kind} resources ${refusal}.`);
  }
  return ref.uri;
}

export function integer(value: string, label: string, minimum = 0): number {
  if (!/^-?\d+$/.test(value)) throw usageError(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw usageError(`${label} must be at least ${minimum}.`);
  }
  return parsed;
}

/** Parse seconds, mm:ss, hh:mm:ss, or a compact duration such as 1h2m3s. */
export function durationMs(value: string): number {
  const trimmed = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(trimmed))
    return Math.round(Number(trimmed) * 1_000);

  if (/^\d{1,3}:\d{1,2}(?::\d{1,2})?$/.test(trimmed)) {
    const values = trimmed.split(":").map(Number);
    const seconds = values.reduce((total, part) => total * 60 + part, 0);
    return seconds * 1_000;
  }

  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)];
  if (
    matches.length > 0 &&
    matches.map((match) => match[0]).join("") === trimmed
  ) {
    let seconds = 0;
    for (const match of matches) {
      const amount = Number(match[1]);
      seconds +=
        match[2] === "h"
          ? amount * 3_600
          : match[2] === "m"
            ? amount * 60
            : amount;
    }
    return Math.round(seconds * 1_000);
  }
  throw usageError(
    `Invalid time: ${value}`,
    "Use seconds, mm:ss, hh:mm:ss, or values like 2m30s.",
  );
}

export function signedDurationMs(value: string): {
  relative: boolean;
  milliseconds: number;
} {
  const relative = value.startsWith("+") || value.startsWith("-");
  const sign = value.startsWith("-") ? -1 : 1;
  const raw = relative ? value.slice(1) : value;
  return { relative, milliseconds: sign * durationMs(raw) };
}

export function signedPercent(value: string): {
  relative: boolean;
  percent: number;
} {
  const normalized = value.endsWith("%") ? value.slice(0, -1) : value;
  const relative = normalized.startsWith("+") || normalized.startsWith("-");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    throw usageError(
      `Invalid volume: ${value}`,
      "Use 0–100 or a relative value such as +5 or -10.",
    );
  }
  const percent = Number(normalized);
  if (!relative && (percent < 0 || percent > 100)) {
    throw usageError("Volume must be between 0 and 100.");
  }
  return { relative, percent };
}

/** Parse an ISO 8601 date-time or epoch milliseconds into epoch milliseconds. */
export function timestampMs(value: string, label: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) return parsed;
  } else {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw usageError(
    `Invalid ${label}: ${value}`,
    "Use an ISO 8601 date-time such as 2026-08-01T12:00:00Z, or epoch milliseconds.",
  );
}

export function booleanValue(value: string): boolean {
  switch (value.toLowerCase()) {
    case "on":
    case "true":
    case "yes":
    case "1":
      return true;
    case "off":
    case "false":
    case "no":
    case "0":
      return false;
    default:
      throw usageError(`Expected on or off, received: ${value}`);
  }
}
