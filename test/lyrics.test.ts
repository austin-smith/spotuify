import { afterEach, describe, expect, test } from "bun:test";
import {
  decodeEntities,
  fetchLyrics,
  extractLyrics,
  improveQuery,
  isSection,
  pickHit,
  toLines,
  type SongHit,
} from "../src/api/lyrics.ts";

/**
 * A Genius page, reduced to the structures that matter.
 *
 * Copied in shape from a real one: the lyric lives in `data-lyrics-container` elements, the words
 * are buried inside annotation links and formatting spans, lines are separated by `<br/>` rather
 * than by markup, apostrophes arrive as entities, and a `data-exclude-from-selection` header sits
 * *inside* the container holding contributor counts and translation links.
 */
const PAGE = `<!doctype html><html><body>
<div class="not-lyrics">Everything here should be ignored.</div>
<div data-lyrics-container="true" class="Lyrics__Container">
  <div data-exclude-from-selection="true" class="LyricsHeader__Container">
    <button><span>176 Contributors</span></button>
    <div><ul><li><a href="/x">Русский (Russian)</a></li></ul></div>
    <a href="/bio"><span>The song&#x27;s lyrics tie in with a… <span>Read More</span></span></a>
  </div>
  <a href="/1" class="ReferentFragment"><span><b>[Part I]</b></span></a><br/><br/>[Verse 1]<br/>
  <a href="/2" class="ReferentFragment"><span>Please could you stop the noise? I&#x27;m trying to get some rest<br/>From all the unborn chicken voices in my head</span></a>
  <span tabindex="0" style="opacity:0"></span><br/><br/>[Refrain]<br/>
  <span>What&#x27;s that? (<i>I may be paranoid</i>)</span>
</div>
<div data-lyrics-container="true" class="Lyrics__Container">[Part II]<br/>Ambition makes you look pretty ugly</div>
<footer>About Genius Contributor Guidelines</footer>
</body></html>`;

describe("extractLyrics", () => {
  const lines = toLines(extractLyrics(PAGE));

  test("takes only the lyric containers", () => {
    expect(lines.join("\n")).not.toContain("should be ignored");
    expect(lines.join("\n")).not.toContain("Contributor Guidelines");
  });

  /**
   * The header is *inside* the lyric container, so a parser that simply reads the container's text
   * opens every song with "176 Contributors" and a list of translations.
   */
  test("skips the excluded header inside the container", () => {
    const joined = lines.join("\n");
    expect(joined).not.toContain("176 Contributors");
    expect(joined).not.toContain("Russian");
    expect(joined).not.toContain("Read More");
  });

  test("keeps words nested inside annotation links and formatting", () => {
    expect(lines).toContain("Please could you stop the noise? I'm trying to get some rest");
    expect(lines).toContain("What's that? (I may be paranoid)");
  });

  test("breaks lines on <br>, not on markup", () => {
    expect(lines).toContain("From all the unborn chicken voices in my head");
  });

  test("resolves entities", () => {
    expect(lines.join("\n")).not.toContain("&#x27;");
  });

  test("joins every container", () => {
    expect(lines).toContain("[Part II]");
    expect(lines).toContain("Ambition makes you look pretty ugly");
  });

  // Genius is inconsistent about the blank line above a section, which otherwise renders as ragged
  // gaps that look like a bug.
  test("puts exactly one blank line above each section", () => {
    for (const [index, line] of lines.entries()) {
      if (index === 0 || !isSection(line)) continue;
      expect(lines[index - 1]).toBe("");
      expect(lines[index - 2]).not.toBe("");
    }
  });

  test("never starts or ends on blank space", () => {
    expect(lines.at(0)).not.toBe("");
    expect(lines.at(-1)).not.toBe("");
  });

  test("yields nothing for a page with no lyric container", () => {
    expect(toLines(extractLyrics("<html><body><p>nope</p></body></html>"))).toEqual([]);
  });
});

describe("improveQuery", () => {
  const cases: [string, string, string][] = [
    ["Paranoid Android - 2017 Remaster", "Radiohead", "paranoid android radiohead"],
    ["Bohemian Rhapsody - 2011 Mix", "Queen", "bohemian rhapsody queen"],
    ["Levels - Radio Edit", "Avicii", "levels avicii"],
    ["Dreams (2004 Remaster)", "Fleetwood Mac", "dreams fleetwood mac"],
    ["Sunflower (feat. Post Malone)", "Swae Lee", "sunflower swae lee"],
    ["Song (with Someone)", "Band", "song band"],
    ["Mr. Brightside", "The Killers", "mr. brightside the killers"],
  ];

  for (const [title, artist, expected] of cases) {
    test(`"${title}" -> "${expected}"`, () => {
      expect(improveQuery(title, artist)).toBe(expected);
    });
  }

  // Scrubbing metadata must never scrub the whole title away and search for the artist alone.
  test("keeps a title that is entirely metadata-shaped", () => {
    expect(improveQuery("Remix", "Artist")).toBe("remix artist");
    expect(improveQuery("Live", "Artist")).toBe("live artist");
  });

  test("keeps a dash that is part of the title", () => {
    expect(improveQuery("Sunday Bloody Sunday - Live From Boston", "U2")).toBe(
      "sunday bloody sunday u2",
    );
    expect(improveQuery("Say It Ain't So", "Weezer")).toBe("say it ain't so weezer");
  });

  test("keeps semantic suffixes that are part of the title", () => {
    expect(improveQuery("Love - Hate", "Band")).toBe("love - hate band");
    expect(improveQuery("Love - Democracy", "Band")).toBe("love - democracy band");
    expect(improveQuery("Time (You and I)", "Khruangbin")).toBe(
      "time (you and i) khruangbin",
    );
  });
});

describe("pickHit", () => {
  const hit = (title: string, artistNames: string): SongHit => ({
    url: `https://genius.com/${title}`,
    title,
    artistNames,
  });

  /**
   * Genius hosts translation pages credited to accounts like "Genius Türkçe Çeviriler". They rank
   * highly and contain the lyric in the wrong language.
   */
  test("skips Genius translation pages", () => {
    const chosen = pickHit(
      [hit("Paranoid Android (Türkçe Çeviri)", "Genius Türkçe Çeviriler"), hit("Paranoid Android", "Radiohead")],
      { title: "Paranoid Android", artists: ["Radiohead"] },
    );
    expect(chosen?.artistNames).toBe("Radiohead");
  });

  // Genius will happily return a cover, or an unrelated song with the same title, as its top hit.
  test("prefers a hit whose artist matches", () => {
    const chosen = pickHit(
      [hit("Creep", "Some Cover Band"), hit("Creep", "Radiohead")],
      { title: "Creep", artists: ["Radiohead"] },
    );
    expect(chosen?.artistNames).toBe("Radiohead");
  });

  test("rejects a different song by the correct artist", () => {
    expect(
      pickHit([hit("Karma Police", "Radiohead")], {
        title: "Creep",
        artists: ["Radiohead"],
      }),
    ).toBeNull();
  });

  test("does not treat generic artist words as identity", () => {
    const chosen = pickHit(
      [
        hit("Bloodbuzz Ohio", "The Weeknd"),
        hit("Bloodbuzz Ohio", "The National"),
      ],
      { title: "Bloodbuzz Ohio", artists: ["The National"] },
    );
    expect(chosen?.artistNames).toBe("The National");
  });

  test("requires a complete artist name rather than one shared word", () => {
    expect(
      pickHit([hit("Forever", "Lil Beta")], {
        title: "Forever",
        artists: ["Lil Alpha"],
      }),
    ).toBeNull();
  });

  test("distinguishes non-Latin titles instead of normalising both to empty", () => {
    expect(
      pickHit([hit("世界", "Someone")], {
        title: "花",
        artists: ["Someone"],
      }),
    ).toBeNull();
  });

  // Genius answers almost any query with something; taking its top hit regardless is how "Miss You"
  // came back as a Patrick Kavanagh poem. A wrong lyric is worse than none.
  test("refuses a hit that agrees on neither artist nor title", () => {
    expect(pickHit([hit("The Great Hunger", "Patrick Kavanagh")], { title: "Miss You", artists: ["Oliver Tree"] })).toBeNull();
  });

  test("rejects a title match credited to an unrelated artist", () => {
    expect(
      pickHit([hit("Creep", "Someone Else")], {
        title: "Creep",
        artists: ["Radiohead"],
      }),
    ).toBeNull();
  });

  test("ignores punctuation and case when comparing titles", () => {
    const chosen = pickHit([hit("Say It Ain't So", "Weezer")], {
      title: "say it aint so",
      artists: ["Weezer"],
    });
    expect(chosen).not.toBeNull();
  });

  test("matches one artist out of several", () => {
    const chosen = pickHit(
      [hit("Sunflower", "Post Malone & Swae Lee")],
      { title: "Sunflower", artists: ["Swae Lee", "Post Malone"] },
    );
    expect(chosen).not.toBeNull();
  });

  test("has nothing to offer when every hit is a translation", () => {
    expect(pickHit([hit("X", "Genius Farsi Translations")], { title: "X", artists: ["Radiohead"] })).toBeNull();
  });

  test("has nothing to offer for no hits", () => {
    expect(pickHit([], { title: "X", artists: ["Radiohead"] })).toBeNull();
  });

  test("allows a legitimate artist whose name contains Genius", () => {
    expect(
      pickHit([hit("Slip Away", "Perfume Genius")], {
        title: "Slip Away",
        artists: ["Perfume Genius"],
      }),
    ).not.toBeNull();
  });

  test("matches an artist whose entire name consists of ignored words", () => {
    expect(
      pickHit([hit("This Is the Day", "The The")], {
        title: "This Is the Day",
        artists: ["The The"],
      }),
    ).not.toBeNull();
  });
});

describe("decodeEntities", () => {
  test("decodes hex, decimal and named entities", () => {
    expect(decodeEntities("I&#x27;m &amp; you&#39;re &quot;here&quot;")).toBe(`I'm & you're "here"`);
  });

  test("leaves unknown entities alone rather than mangling them", () => {
    expect(decodeEntities("100 &fake; 200")).toBe("100 &fake; 200");
  });

  test("survives an out-of-range code point", () => {
    expect(decodeEntities("&#99999999;")).toBe("&#99999999;");
  });
});

describe("isSection", () => {
  test("recognises section markers", () => {
    expect(isSection("[Verse 1]")).toBe(true);
    expect(isSection("[Chorus: Etta James]")).toBe(true);
  });

  test("leaves sung lines alone", () => {
    expect(isSection("What's that? (I may be paranoid)")).toBe(false);
    expect(isSection("")).toBe(false);
  });
});

describe("fetchLyrics", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const PAGE_HTML = `<div data-lyrics-container="true">Don&#x27;t remind me<br/>Second line</div>`;

  /** Answer Genius's search only for `answersFor`, and serve one lyric page. */
  function stub(answersFor: string, hit: { title: string; artist: string }): string[] {
    const queries: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/search")) {
        const q = url.searchParams.get("q") ?? "";
        queries.push(q);
        const hits =
          q === answersFor
            ? [
                {
                  type: "song",
                  result: {
                    url: "https://genius.com/song",
                    title: hit.title,
                    artist_names: hit.artist,
                  },
                },
              ]
            : [];
        return new Response(JSON.stringify({ meta: { status: 200 }, response: { hits } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    return queries;
  }

  test("finds a lyric on the first, careful query", async () => {
    const queries = stub("paranoid android radiohead", {
      title: "Paranoid Android",
      artist: "Radiohead",
    });
    const lyrics = await fetchLyrics({
      name: "Paranoid Android - 2017 Remaster",
      artists: ["Radiohead"],
    });
    expect(lyrics.lines[0]).toBe("Don't remind me");
    expect(queries).toEqual(["paranoid android radiohead"]);
  });

  test("strips known release metadata without a second request", async () => {
    const queries = stub("miss you oliver tree", {
      title: "Miss You",
      artist: "Oliver Tree & Robin Schulz",
    });
    const lyrics = await fetchLyrics({
      name: "Miss You - Bonus Track",
      artists: ["Oliver Tree", "Robin Schulz"],
    });
    expect(lyrics.title).toBe("Miss You");
    expect(queries).toEqual(["miss you oliver tree"]);
  });

  test("strips known speed metadata without a fallback search", async () => {
    const queries = stub("miss you oliver tree", {
      title: "Miss You",
      artist: "Oliver Tree & Robin Schulz",
    });
    const lyrics = await fetchLyrics({
      name: "Miss You - Sped Up",
      artists: ["Oliver Tree", "Robin Schulz"],
    });
    expect(lyrics.title).toBe("Miss You");
    expect(queries).toEqual(["miss you oliver tree"]);
  });

  test("does not repeat an identical query", async () => {
    const queries = stub("nothing matches this", { title: "X", artist: "Y" });
    await expect(fetchLyrics({ name: "Fake Empire", artists: ["The National"] })).rejects.toThrow(
      "no lyrics found",
    );
    expect(queries).toEqual(["fake empire the national"]);
  });

  // Only the lead artist goes into the query; the rest would be noise Genius searches on.
  test("queries with the lead artist alone", async () => {
    const queries = stub("sunflower swae lee", { title: "Sunflower", artist: "Post Malone" });
    await fetchLyrics({ name: "Sunflower (feat. Post Malone)", artists: ["Swae Lee", "Post Malone"] });
    expect(queries[0]).toBe("sunflower swae lee");
  });

  test("reports a page that yields no words rather than showing an empty overlay", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/search")) {
        return new Response(
          JSON.stringify({
            meta: { status: 200 },
            response: {
              hits: [
                {
                  type: "song",
                  result: { url: "https://genius.com/s", title: "X", artist_names: "The National" },
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html><body>no lyric here</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    await expect(fetchLyrics({ name: "X", artists: ["The National"] })).rejects.toThrow(
      "no lyrics found",
    );
  });

  test("surfaces a Genius outage as a failure, not as an empty lyric", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLyrics({ name: "X", artists: ["Y"] })).rejects.toThrow("genius search failed");
  });
});
