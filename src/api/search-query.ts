import type { SearchScope } from "./search.ts";

export type SpotifySearchType = Exclude<SearchScope, "all">;

const ALL_TYPES: readonly SpotifySearchType[] = ["track", "artist", "album", "playlist"];

const FILTER_TYPES = {
  artist: ["track", "artist", "album"],
  album: ["track", "album"],
  track: ["track"],
  year: ["track", "artist", "album"],
  genre: ["track", "artist"],
  isrc: ["track"],
  upc: ["album"],
  tag: ["album"],
} as const satisfies Record<string, readonly SpotifySearchType[]>;

type SearchFilter = keyof typeof FILTER_TYPES;

export class IncompatibleSearchFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatibleSearchFilterError";
  }
}

/**
 * Extract only Spotify's documented field filters.
 *
 * `type:` is intentionally absent. Scope belongs to the visible scope control, not a magic token
 * that silently changes the meaning of the query.
 */
export function searchFilters(query: string): SearchFilter[] {
  const fields: SearchFilter[] = [];
  const pattern = /(?:^|\s)(artist|album|track|year|genre|isrc|upc|tag):("[^"]+"|\S+)/gi;
  for (const match of query.matchAll(pattern)) {
    const field = match[1]?.toLowerCase() as SearchFilter | undefined;
    const value = match[2]?.replace(/^"|"$/g, "").toLowerCase();
    // Spotify documents exactly two tag filters. An arbitrary `tag:value` remains ordinary query
    // text and must not silently narrow an all-scope search to albums.
    if (field === "tag" && value !== "new" && value !== "hipster") continue;
    if (field !== undefined && !fields.includes(field)) fields.push(field);
  }
  return fields;
}

/** Types that can legally receive the query under the chosen visible scope. */
export function eligibleSearchTypes(scope: SearchScope, query: string): SpotifySearchType[] {
  const filters = searchFilters(query);
  const scoped = scope === "all" ? [...ALL_TYPES] : [scope];
  const eligible = filters.reduce<SpotifySearchType[]>(
    (types, field) => {
      const supported = new Set<SpotifySearchType>(FILTER_TYPES[field]);
      return types.filter((type) => supported.has(type));
    },
    scoped,
  );
  if (eligible.length > 0 || filters.length === 0) return eligible;

  if (scope !== "all") {
    throw new IncompatibleSearchFilterError(
      `${filters.map((field) => `${field}:`).join(" + ")} cannot filter ${scope} results`,
    );
  }
  throw new IncompatibleSearchFilterError(
    `${filters.map((field) => `${field}:`).join(" + ")} cannot be combined`,
  );
}
