/**
 * Lyrics, from Genius.
 *
 * Spotify has no public lyrics endpoint, so this talks to Genius instead — which means none of the
 * endpoints deprecated in November 2024 apply here, and nothing in this file needs a Spotify token.
 * Genius's own search API answers unauthenticated; the lyric itself only exists in the page HTML.
 */

const SEARCH_URL = "https://genius.com/api/search";

/** Genius is not on the critical path — give up rather than hang the overlay on a slow page. */
const TIMEOUT_MS = 10_000;

export interface Lyrics {
  /** Genius's title and artist, which is what was actually matched — not what Spotify calls it. */
  title: string;
  artists: string;
  url: string;
  /** Lyric lines, blank lines included, section markers like `[Verse 1]` on their own line. */
  lines: string[];
}

export class LyricsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LyricsUnavailableError";
  }
}

export interface SongHit {
  url: string;
  title: string;
  artistNames: string;
}

interface RawSearchBody {
  meta?: { status?: number; message?: string };
  response?: {
    hits?: ({
      type?: string;
      result?: { url?: string; title?: string; artist_names?: string };
    } | null)[];
  };
}

/**
 * What a dash-introduced segment has to look like before it is treated as release metadata rather
 * than part of the title.
 */
const METADATA_SEGMENT =
  /\b(?:remaster(?:ed)?|remix|mix|version|edit|mono|stereo|live|acoustic|demo|instrumental|bonus|deluxe|edition|anniversary|expanded|nightcore)\b|\bsped[- ]?up\b|\bslowed(?: down)?\b|\b(?:19|20)\d{2}\b/;

/**
 * Strip the parts of a Spotify track name that Genius does not have.
 *
 * Spotify titles carry release metadata — "Paranoid Android - 2017 Remaster", "Levels - Skrillex
 * Remix", "Song (feat. X)" — and searching Genius with any of it attached reliably returns either
 * nothing or the wrong song. Returned lowercase, which is how Genius's search behaves anyway.
 */
function improveTitle(title: string): string {
  let name = title.toLowerCase();

  // Featured artists live in the artist field on Genius, never the title.
  name = name.replace(/\s*[([](?:feat\.?|featuring|with)\s[^)\]]*[)\]]/g, "");
  // Parenthesised release metadata: "(remastered 2011)", "(acoustic version)". Parentheticals that
  // do not identify known metadata are part of the title and stay intact.
  name = name.replace(
    /\s*[([]([^)\]]*)[)\]]/g,
    (whole: string, segment: string) => (METADATA_SEGMENT.test(segment) ? "" : whole),
  );

  // Dash-introduced metadata: "title - 2011 remastered", "title - radio edit", "title - 2011 mix".
  // Everything after a spaced dash on a Spotify title is release metadata in practice, but only
  // segments that actually look like it are dropped — "bohemian rhapsody - 2011 mix" otherwise
  // matches Genius's a cappella mix page instead of the song.
  const segments = name.split(/\s+-\s+/);
  if (segments.length > 1) {
    const kept = [segments[0] ?? ""];
    for (const segment of segments.slice(1)) {
      if (!METADATA_SEGMENT.test(segment)) kept.push(segment);
    }
    name = kept.join(" - ");
  }

  const cleaned = name.replace(/\s+/g, " ").trim();
  // Refuse to hand back an empty or near-empty title: a song genuinely called "Remix" would
  // otherwise be scrubbed down to nothing and search for the artist alone.
  return cleaned.length >= 2 ? cleaned : title.toLowerCase().trim();
}

export function improveQuery(title: string, artist: string): string {
  return `${improveTitle(title)} ${artist.toLowerCase()}`.replace(/\s+/g, " ").trim();
}

/** Compare titles using Unicode letters and numbers, ignoring case, punctuation and spacing. */
function titleKey(value: string): string {
  return (value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

function artistWords(value: string): string[] {
  return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsWords(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  return haystack.some(
    (_, start) =>
      start + needle.length <= haystack.length &&
      needle.every((word, offset) => haystack[start + offset] === word),
  );
}

/**
 * The best hit for a track, or null when Genius has nothing that plausibly matches.
 *
 * Genius will answer almost any query with something. Returning its top hit unconditionally is how
 * "Miss You" by Oliver Tree came back as a Patrick Kavanagh poem — a confidently wrong lyric, which
 * is a worse outcome than admitting there is none. So a hit's title has to match the original or a
 * deliberate metadata-stripped variant, and it must share a meaningful artist token.
 *
 * Translation pages, credited to accounts like "Genius Türkçe Çeviriler", are dropped outright:
 * they rank highly and hold the lyric in the wrong language.
 */
export function pickHit(
  hits: SongHit[],
  track: { title: string; artists: string[] },
): SongHit | null {
  const acceptableTitles = new Set(
    [track.title, improveTitle(track.title)]
      .map(titleKey)
      .filter((key) => key.length > 0),
  );
  const requestedGeniusAccount = track.artists.some((artist) =>
    /^\s*genius(?:\s|$)/i.test(artist),
  );
  const candidates = hits.filter(
    (hit) =>
      (!/^\s*genius(?:\s|$)/i.test(hit.artistNames) || requestedGeniusAccount) &&
      acceptableTitles.has(titleKey(hit.title)),
  );
  if (candidates.length === 0) return null;

  const wantedArtists = track.artists.map(artistWords).filter((words) => words.length > 0);

  // The title is already known to match, but that alone is shared by covers, remakes and unrelated
  // songs. Require one complete requested artist name inside the candidate's credits; this accepts
  // collaborations without confusing artists that merely share a word.
  const byArtist = candidates.find((hit) => {
    const credited = artistWords(hit.artistNames);
    return wantedArtists.some((wanted) => containsWords(credited, wanted));
  });
  return byArtist ?? null;
}

function signalFor(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Songs matching `query`, most relevant first. */
export async function searchSongs(query: string, signal?: AbortSignal): Promise<SongHit[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);

  const res = await fetch(url, { signal: signalFor(signal) });
  if (!res.ok) throw new LyricsUnavailableError(`genius search failed (${res.status})`);

  const body = (await res.json()) as RawSearchBody;
  if (body.meta?.status !== undefined && body.meta.status !== 200) {
    throw new LyricsUnavailableError(body.meta.message ?? "genius search failed");
  }

  const hits: SongHit[] = [];
  for (const hit of body.response?.hits ?? []) {
    if (hit?.type !== "song" || hit.result === undefined) continue;
    const { url: href, title, artist_names } = hit.result;
    if (typeof href !== "string" || typeof title !== "string") continue;
    hits.push({ url: href, title, artistNames: artist_names ?? "" });
  }
  return hits;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Resolve HTML entities in extracted text.
 *
 * The HTML parser hands back text exactly as written in the source, so a page full of `&#x27;` would
 * otherwise render as `I&#x27;m trying to get some rest`.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1]?.toLowerCase() === "x";
      const code = isHex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Pull the lyric out of a Genius page.
 *
 * Parsed with `HTMLRewriter` rather than a regex: the lyric is spread across nested annotation
 * links and formatting spans, and the only stable landmarks are the `data-lyrics-container`
 * elements. Anything marked `data-exclude-from-selection` is skipped — that is the contributor
 * count, the translation dropdown and the song-bio blurb, all of which sit *inside* the lyric
 * container and would otherwise open the lyric with "176 ContributorsTranslations…".
 */
export function extractLyrics(html: string): string {
  const parts: string[] = [];
  let inLyrics = 0;
  let excluded = 0;

  new HTMLRewriter()
    .on("[data-lyrics-container]", {
      element(element) {
        inLyrics++;
        element.onEndTag(() => {
          inLyrics--;
          // Genius splits long lyrics across several containers; without this the last line of one
          // runs into the first line of the next.
          parts.push("\n");
        });
      },
    })
    .on("[data-exclude-from-selection]", {
      element(element) {
        excluded++;
        element.onEndTag(() => {
          excluded--;
        });
      },
    })
    .on("br", {
      element() {
        if (inLyrics > 0 && excluded === 0) parts.push("\n");
      },
    })
    .onDocument({
      text(chunk) {
        if (inLyrics > 0 && excluded === 0) parts.push(chunk.text);
      },
    })
    .transform(html);

  return decodeEntities(parts.join(""));
}

/**
 * Split a raw lyric into display lines.
 *
 * Genius is inconsistent about the blank line before a section marker, so sections are normalised to
 * exactly one blank line above them and runs of blank lines are collapsed. Without this the same
 * song renders with ragged gaps that look like a rendering fault.
 */
export function toLines(lyric: string): string[] {
  const normalised = lyric
    .replace(/\r\n?/g, "\n")
    // Trim each line before anything else. Indentation in the page source becomes real text, and a
    // line of nothing but spaces is not blank to a regex — it silently defeats the collapsing below
    // and leaves double gaps above sections.
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}(\[)/g, "\n$1")
    .replace(/\n(\[)/g, "\n\n$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalised.length === 0) return [];
  return normalised.split("\n");
}

/** Whether a line is a section marker like `[Chorus]` rather than a sung line. */
export function isSection(line: string): boolean {
  return line.startsWith("[") && line.trimEnd().endsWith("]");
}

/**
 * The lyric for a track, or a `LyricsUnavailableError` explaining why there is none.
 *
 * Two requests: Genius's search API to find the song, then its page for the words.
 */
export async function fetchLyrics(
  track: { name: string; artists: string[] },
  options: { signal?: AbortSignal } = {},
): Promise<Lyrics> {
  /**
   * Only the lead artist goes into the query.
   *
   * Genius searches the whole string, so every extra credited name is noise: "miss you oliver tree,
   * robin schulz" returned an unrelated poem, while "miss you oliver tree" finds the song. The full
   * list is still used to recognise the right hit, since Genius credits collaborations in full.
   */
  const lead = track.artists[0] ?? "";
  const wanted = { title: track.name, artists: track.artists };

  const query = improveQuery(track.name, lead);
  const hit = pickHit(await searchSongs(query, options.signal), wanted);

  if (hit === null) throw new LyricsUnavailableError("no lyrics found for this track");

  const res = await fetch(hit.url, { signal: signalFor(options.signal) });
  if (!res.ok) throw new LyricsUnavailableError(`genius page failed (${res.status})`);

  const lines = toLines(extractLyrics(await res.text()));
  // A page that exists but yields nothing means Genius changed its markup, or the song is a
  // placeholder with no transcription yet. Either way there is nothing to show.
  if (lines.length === 0) throw new LyricsUnavailableError("no lyrics found for this track");

  return { title: hit.title, artists: hit.artistNames, url: hit.url, lines };
}
