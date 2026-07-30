/**
 * Time-synced lyrics, from LRCLIB.
 *
 * The reason the overlay can follow along: Genius returns words with no timing, while LRCLIB returns
 * LRC — every line stamped with the moment it is sung. Free, unauthenticated, and like Genius it
 * touches no Spotify endpoint.
 */

import type { LyricLine } from "./lyrics.ts";
import { VERSION } from "../version.ts";

const BASE_URL = "https://lrclib.net/api";

/** A single LRCLIB request may be slow without holding the fallback path open indefinitely. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Total time the optional timing provider may delay the established Genius fallback.
 *
 * This still leaves room for the normal exact-then-search cascade and its required request gap
 * when LRCLIB is healthy, while keeping a degraded service from adding its full per-request timeout
 * to the user-visible wait.
 */
export const LRCLIB_STAGE_TIMEOUT_MS = 3_000;

/** LRCLIB asks clients to identify themselves rather than arrive anonymously. */
const USER_AGENT = `spotuify/${VERSION} (https://github.com/austin-smith/spotuify)`;

/**
 * LRCLIB asks clients to make requests sequentially and leave 200–500ms between them.
 *
 * Kept at the documented lower bound because opening lyrics is interactive, while the shared queue
 * still protects the service when a lookup falls through from exact match to search or when tracks
 * change quickly.
 */
const REQUEST_GAP_MS = 200;

/**
 * How far a candidate's duration may sit from the track's before it is treated as a different
 * recording. LRCLIB's own exact-match endpoint uses two seconds.
 */
const DURATION_TOLERANCE_S = 2;

/** Back off conservatively when a 429 omits or mangles the required `Retry-After` header. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

export type LrclibResult =
  | { kind: "lyrics"; title: string; artists: string; lines: LyricLine[]; synced: boolean }
  /** LRCLIB knows the track and says it has no words at all. */
  | { kind: "instrumental" }
  | { kind: "none" };

interface RawRecord {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
}

interface LrclibTrack {
  name: string;
  artists: string[];
  durationMs?: number;
}

/** LRCLIB's line timestamp, kept separate from literal bracketed lyric text. */
const LRC_TIMESTAMP = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LRC_OFFSET = /^\s*\[offset:([+-]?\d+)\]\s*$/gim;

/** Case- and punctuation-insensitive identity for an LRCLIB title or artist. */
function textKey(value: string): string {
  return (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

/** Common separators between independently credited artists. */
const ARTIST_SEPARATOR = /\s*(?:[,&/;]|\b(?:feat(?:uring)?|ft|with|and|x)\.?\b)\s*/iu;

/** Search is fuzzy, so its records still have to identify the track we asked for. */
function matchesTrack(record: RawRecord, track: LrclibTrack): boolean {
  if (textKey(record.trackName ?? "") !== textKey(track.name)) return false;

  const artistName = record.artistName ?? "";
  const credited = new Set(
    [artistName, ...artistName.split(ARTIST_SEPARATOR)]
      .map(textKey)
      .filter((key) => key.length > 0),
  );
  const primaryArtist = track.artists[0];
  return primaryArtist !== undefined && credited.has(textKey(primaryArtist));
}

/** Whether a record's duration can identify the requested recording. */
function matchesDuration(record: RawRecord, track: LrclibTrack): boolean {
  if (track.durationMs === undefined || record.duration === undefined) return true;
  return Math.abs(record.duration - track.durationMs / 1000) <= DURATION_TOLERANCE_S;
}

/**
 * Parse an LRC document into stamped lines.
 *
 * A line may carry several timestamps when the same words repeat, in which case it is emitted once
 * per occurrence. Metadata rows such as `[ar:Radiohead]` carry no timestamp and are skipped, and
 * stamped rows with no words are kept — those are the instrumental gaps, and dropping them would
 * make the highlight jump early.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offsetValue = [...lrc.matchAll(LRC_OFFSET)].at(-1)?.[1];
  const parsedOffset = offsetValue === undefined ? 0 : Number(offsetValue);
  const offsetMs = Number.isFinite(parsedOffset) ? parsedOffset : 0;

  for (const row of lrc.split("\n")) {
    const stamps = [...row.matchAll(LRC_TIMESTAMP)];
    if (stamps.length === 0) continue;

    // Remove only timing tokens. Section labels and annotations such as `[Chorus]` or `[whispers]`
    // are lyric text and must survive.
    const text = row.replace(LRC_TIMESTAMP, "").trim();
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      // "12" is 120ms, not 12ms — pad before reading it as a fraction of a second.
      const fraction = stamp[3] === undefined ? 0 : Number(stamp[3].padEnd(3, "0"));
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
      const stampedAt = minutes * 60_000 + seconds * 1_000 + fraction;
      // In LRC, a positive offset advances the lyric and a negative one delays it.
      lines.push({ text, atMs: Math.max(0, stampedAt - offsetMs) });
    }
  }

  return lines.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
}

/** Parsed synchronized rows, only when at least one of them contains something to sing. */
function syncedLines(record: RawRecord): LyricLine[] | null {
  const synced = record.syncedLyrics;
  if (typeof synced !== "string" || synced.trim().length === 0) return null;

  const lines = parseLrc(synced);
  // Stamped blank rows are meaningful gaps inside a real lyric, but some records contain only a
  // trailing placeholder. Do not let one suppress valid plain words or produce an empty overlay.
  return lines.some((line) => line.text.trim().length > 0) ? lines : null;
}

function toResult(record: RawRecord): LrclibResult {
  if (record.instrumental === true) return { kind: "instrumental" };

  const title = record.trackName ?? "";
  const artists = record.artistName ?? "";

  const timed = syncedLines(record);
  if (timed !== null) {
    return { kind: "lyrics", title, artists, lines: timed, synced: true };
  }

  const plain = record.plainLyrics;
  if (typeof plain === "string" && plain.trim().length > 0) {
    const lines = plain
      .split("\n")
      .map((text) => ({ text: text.trim(), atMs: null }));
    return { kind: "lyrics", title, artists, lines, synced: false };
  }

  return { kind: "none" };
}

function signalFor(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Do not touch LRCLIB again before this wall-clock time after it rate limits us. */
let retryAfterAtMs = 0;

/** When the last network request completed, measured monotonically for request spacing. */
let lastRequestFinishedAtMs = Number.NEGATIVE_INFINITY;

/**
 * Every LRCLIB request joins this queue. Recover rejections before storing the tail so one failed
 * request cannot poison every later lookup.
 */
let requestQueue: Promise<void> = Promise.resolve();

class LrclibCooldownError extends Error {
  constructor() {
    super("lrclib is rate limited");
    this.name = "LrclibCooldownError";
  }
}

/** Absolute retry deadline from either legal `Retry-After` representation. */
function retryDeadline(value: string | null, nowMs: number): number {
  const trimmed = value?.trim() ?? "";
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return nowMs + seconds * 1_000;
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(nowMs, date);
  return nowMs + DEFAULT_RETRY_AFTER_MS;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("the operation was aborted", "AbortError");
}

/** A delay that stops promptly when its caller's lookup has been superseded. */
async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted === true) throw abortReason(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function request(path: string, query: Record<string, string>, signal?: AbortSignal) {
  const queued = requestQueue.then(async () => {
    if (signal?.aborted === true) throw abortReason(signal);
    if (Date.now() < retryAfterAtMs) throw new LrclibCooldownError();

    const elapsed = performance.now() - lastRequestFinishedAtMs;
    await wait(REQUEST_GAP_MS - elapsed, signal);

    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value.length > 0) url.searchParams.set(key, value);
    }

    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        signal: signalFor(signal),
      });
      if (response.status === 429) {
        retryAfterAtMs = Math.max(
          retryAfterAtMs,
          retryDeadline(response.headers.get("retry-after"), Date.now()),
        );
      }
      return response;
    } finally {
      lastRequestFinishedAtMs = performance.now();
    }
  });

  requestQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return await queued;
}

/**
 * Pick the best of several candidates.
 *
 * Synced beats plain outright — following along is the whole point — and within each kind the
 * closest duration wins, because a "remix" or a live cut of the same title is a different recording
 * whose timings would drift immediately.
 */
export function pickRecord(records: RawRecord[], track: LrclibTrack): RawRecord | null {
  const wanted = track.durationMs === undefined ? null : track.durationMs / 1000;
  const hasSynced = new Map(records.map((record) => [record, syncedLines(record) !== null]));
  const usable = records.filter(
    (record) =>
      matchesTrack(record, track) &&
      (record.instrumental === true ||
        hasSynced.get(record) === true ||
        (record.plainLyrics ?? "").trim().length > 0),
  );
  if (usable.length === 0) return null;

  const distance = (record: RawRecord): number => {
    if (wanted === null || record.duration === undefined) return Number.MAX_SAFE_INTEGER;
    return Math.abs(record.duration - wanted);
  };

  // Reject different recordings before considering whether they have timings. Otherwise one
  // mismatched synced upload outranks, then disqualifies, an exact plain or instrumental result.
  const compatible =
    wanted === null
      ? usable
      : usable.filter((record) => matchesDuration(record, track));

  const ranked = [...compatible].sort((a, b) => {
    const aSynced = hasSynced.get(a) === true;
    const bSynced = hasSynced.get(b) === true;
    if (aSynced !== bSynced) return aSynced ? -1 : 1;
    return distance(a) - distance(b);
  });

  return ranked[0] ?? null;
}

/**
 * Look a track up, exactly first and then by search.
 *
 * The exact endpoint needs the duration to agree within a couple of seconds, which fails whenever
 * Spotify and LRCLIB disagree about a track's length — common enough that the search fallback is
 * what finds the lyric perhaps a fifth of the time.
 */
export async function fetchLrclib(
  track: LrclibTrack,
  options: { signal?: AbortSignal } = {},
): Promise<LrclibResult> {
  const artist = track.artists[0] ?? "";
  const duration =
    track.durationMs === undefined ? "" : String(Math.round(track.durationMs / 1000));

  /**
   * The album is deliberately not sent.
   *
   * It reads like free precision and is the opposite. Spotify's album names carry edition suffixes
   * LRCLIB does not share — "Stoney (Deluxe)" against "Stoney" — and supplying one steers the match
   * to a worse record. Measured on "Feeling Whitney": artist and track alone return a synced entry,
   * while adding the album returns an unsynced one, and adding the album without a duration returns
   * a 29-second fragment of something else entirely. The duration is the reliable discriminator.
   */
  const exact = await request(
    "/get",
    { artist_name: artist, track_name: track.name, duration },
    options.signal,
  );

  const exactRecord = exact.ok ? ((await exact.json()) as RawRecord) : null;
  const matched =
    exactRecord !== null &&
    matchesTrack(exactRecord, track) &&
    matchesDuration(exactRecord, track)
      ? toResult(exactRecord)
      : null;
  if (
    matched !== null &&
    (matched.kind === "instrumental" || (matched.kind === "lyrics" && matched.synced))
  ) {
    return matched;
  }

  // Either nothing matched exactly, or what did has no timings. `/get` answers with a single record
  // while `/search` lists every upload of the track, and for a song with both kinds the untimed one
  // is often the one returned — so it is worth looking at the rest before settling.
  try {
    const found = await request(
      "/search",
      { artist_name: artist, track_name: track.name },
      options.signal,
    );

    if (found.ok) {
      const records = (await found.json()) as RawRecord[];
      const best = pickRecord(Array.isArray(records) ? records : [], track);
      const searched = best === null ? null : toResult(best);
      if (searched !== null && searched.kind === "lyrics" && searched.synced) {
        return searched;
      }
      // Exact words beat a conflicting community record that calls the same track instrumental.
      if (matched !== null && matched.kind === "lyrics") return matched;
      if (searched !== null) return searched;
    }
  } catch (error) {
    // Search is only an optional timing upgrade. Never discard exact words because that upgrade
    // timed out, was rate limited, or returned malformed JSON.
    if (matched !== null && matched.kind === "lyrics") return matched;
    throw error;
  }

  return matched ?? { kind: "none" };
}
