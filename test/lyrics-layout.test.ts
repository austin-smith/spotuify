import { describe, expect, test } from "bun:test";
import { useLyrics } from "../src/store/lyrics.ts";
import {
  colorFor,
  distanceFrom,
  fadeProgress,
  followOffset,
  layoutLyrics,
} from "../src/ui/LyricsView.tsx";
import { truncate, wrap } from "../src/ui/text.ts";

describe("truncate", () => {
  test("truncates by terminal columns without splitting graphemes", () => {
    const value = truncate("你好世界", 5);
    expect(value).toBe("你好…");
    expect(Bun.stringWidth(value)).toBe(5);
  });
});

describe("wrap", () => {
  test("leaves a line that already fits", () => {
    expect(wrap("short line", 40)).toEqual(["short line"]);
  });

  test("breaks on word boundaries", () => {
    expect(wrap("the quick brown fox jumps", 10)).toEqual(["the quick", "brown fox", "jumps"]);
  });

  // Truncating here would lose words, which is the whole reason lyrics wrap rather than clip.
  test("keeps every word", () => {
    const line = "Please could you stop the noise? I'm trying to get some rest";
    for (const width of [12, 20, 33, 47]) {
      expect(wrap(line, width).join(" ")).toBe(line);
    }
  });

  test("never exceeds the width", () => {
    const line = "Kicking and squealing, Gucci little piggy, all the way home again";
    for (const width of [8, 15, 30, 64]) {
      expect(wrap(line, width).every((row) => row.length <= width)).toBe(true);
    }
  });

  test("hard-splits a word with no break in it", () => {
    expect(wrap("aaaaaaaaaa", 4)).toEqual(["aaaa", "aaaa", "aa"]);
  });

  test("measures CJK and emoji in terminal columns", () => {
    const rows = wrap("你好世界 👩‍👩‍👧‍👦 family", 8);
    expect(rows.every((row) => Bun.stringWidth(row) <= 8)).toBe(true);
    expect(rows.join(" ")).toBe("你好世界 👩‍👩‍👧‍👦 family");
  });

  test("never splits a combining grapheme", () => {
    const combined = "e\u0301";
    expect(wrap(combined.repeat(4), 2)).toEqual([combined.repeat(2), combined.repeat(2)]);
  });

  // The remainder of a hard-split word may re-flow with the words after it, so the invariant is
  // that no characters are lost — not that the rows line up with the original words.
  test("hard-splits a long word mid-line without losing the rest", () => {
    const line = "hi supercalifragilisticexpialidocious bye";
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(wrap(line, 8).join(""))).toBe(strip(line));
  });

  test("handles zero- and one-column budgets without overflowing", () => {
    expect(wrap("anything", 0)).toEqual([]);
    expect(wrap("abc", 1)).toEqual(["a", "b", "c"]);
    expect(wrap("你好", 1)).toEqual(["…", "…"]);
  });
});

describe("layoutLyrics", () => {
  const lines = [
    "[Verse 1]",
    "Please could you stop the noise? I'm trying to get some rest",
    "",
    "[Refrain]",
  ];

  test("flags section markers so they can be set apart", () => {
    const laid = layoutLyrics(lines, 80);
    expect(laid[0]).toMatchObject({ text: "[Verse 1]", section: true, continuation: false });
    expect(laid[1]?.section).toBe(false);
  });

  test("keeps blank lines as blank rows", () => {
    const laid = layoutLyrics(lines, 80);
    expect(laid.some((l) => l.text === "")).toBe(true);
  });

  // The wrap point moves with the terminal, so this is where a narrow window is verified.
  test("wraps a long line into marked continuations", () => {
    const laid = layoutLyrics([lines[1]!], 30);
    expect(laid.length).toBeGreaterThan(1);
    expect(laid[0]?.continuation).toBe(false);
    expect(laid.slice(1).every((l) => l.continuation)).toBe(true);
  });

  test("loses no words at any width", () => {
    for (const width of [24, 40, 80, 120]) {
      const laid = layoutLyrics([lines[1]!], width);
      expect(laid.map((l) => l.text).join(" ")).toBe(lines[1]!);
    }
  });

  /**
   * Rows have to leave room for the indent and the scroll indicator, or the last character of a
   * wrapped line lands under the scrollbar column.
   */
  test("leaves room for the indent and the scrollbar", () => {
    for (const width of [24, 40, 80]) {
      const laid = layoutLyrics([lines[1]!], width);
      expect(
        laid.every(
          (line) =>
            Bun.stringWidth(line.text) + (line.continuation ? 4 : 2) + 2 <= width,
        ),
      ).toBe(true);
    }
  });

  test("survives a terminal too narrow to lay anything out", () => {
    expect(() => layoutLyrics(lines, 2)).not.toThrow();
  });

  test("has nothing to lay out for no lyric", () => {
    expect(layoutLyrics([], 80)).toEqual([]);
  });
});

describe("lyrics scroll state", () => {
  test("clamps the offset when a wider relayout has fewer lines", () => {
    useLyrics.setState({ offset: 80, total: 100 });
    useLyrics.getState().setTotal(10, 5);
    expect(useLyrics.getState()).toMatchObject({ offset: 5, total: 10 });
  });

  test("clamps the offset when a taller viewport shows more lines", () => {
    useLyrics.setState({ offset: 80, total: 100 });
    useLyrics.getState().setTotal(100, 40);
    expect(useLyrics.getState()).toMatchObject({ offset: 60, total: 100 });
  });
});

describe("layoutLyrics source mapping", () => {
  const lines = ["[Verse 1]", "a much longer line that will certainly wrap at this width", "", "end"];

  test("every row knows which lyric line it came from", () => {
    const laid = layoutLyrics(lines, 40);
    expect(laid[0]?.line).toBe(0);
    expect(laid.at(-1)?.line).toBe(3);
    // Line indices never go backwards, and every source line is represented.
    expect(new Set(laid.map((row) => row.line)).size).toBe(lines.length);
  });


  test("a blank line still maps to its source", () => {
    const laid = layoutLyrics(lines, 40);
    expect(laid.find((row) => row.text === "")?.line).toBe(2);
  });
});

describe("followOffset", () => {
  const VIEWPORT = 20;
  const TOTAL = 100;

  /**
   * The band is the reason this exists. Re-centring on every line moved the page every three to
   * five seconds, and a terminal cannot move by less than a row — so that jump could never be
   * smoothed away. Holding still until the line reaches the edge trades constant small twitches for
   * one larger move that has something to animate.
   */
  test("holds still while the line stays in the middle band", () => {
    for (const row of [25, 28, 30, 33]) {
      expect(followOffset(row, VIEWPORT, TOTAL, 20)).toBe(20);
    }
  });

  test("re-centres once the line reaches the bottom of the band", () => {
    expect(followOffset(35, VIEWPORT, TOTAL, 20)).toBe(25);
  });

  test("re-centres once the line reaches the top of the band", () => {
    expect(followOffset(21, VIEWPORT, TOTAL, 20)).toBe(11);
  });

  // Scrolling back is what happens after a seek backwards, and it needs the same treatment.
  test("re-centres when the line is above the view entirely", () => {
    expect(followOffset(5, VIEWPORT, TOTAL, 60)).toBe(0);
  });

  test("does not scroll above the start", () => {
    expect(followOffset(0, VIEWPORT, TOTAL, 0)).toBe(0);
    expect(followOffset(2, VIEWPORT, TOTAL, 0)).toBe(0);
  });

  test("stops at the end rather than scrolling past it", () => {
    expect(followOffset(99, VIEWPORT, TOTAL, 70)).toBe(80);
  });

  test("handles a lyric shorter than the viewport", () => {
    expect(followOffset(2, 30, 5, 0)).toBe(0);
  });

  test("keeps every row of a wrapped current line in view", () => {
    const offset = followOffset(35, VIEWPORT, TOTAL, 20, 38);
    expect(offset).toBe(26);
    expect(35).toBeGreaterThanOrEqual(offset);
    expect(38).toBeLessThan(offset + VIEWPORT);
  });

  test("shows the beginning when a single line is taller than the viewport", () => {
    expect(followOffset(20, 5, TOTAL, 0, 27)).toBe(20);
  });

  // A band wider than the viewport would leave nowhere to sit and re-centre on every line, which is
  // the behaviour it exists to replace.
  test("keeps a usable band in a very short viewport", () => {
    for (const viewport of [1, 2, 3, 5]) {
      const held = followOffset(10, viewport, TOTAL, 10);
      expect(held).toBeGreaterThanOrEqual(0);
      expect(held).toBeLessThanOrEqual(TOTAL - viewport);
    }
  });
});


describe("brightness falloff", () => {
  /**
   * The intro is the stretch before the first stamped line. Treating it as "distance zero from
   * nothing" lit every line at full brightness, and the whole page then dropped a step the instant
   * the singing started — which reads as the display breaking rather than the song beginning.
   */
  test("during the intro, lines already fade from the top", () => {
    const intro = [0, 1, 2, 3].map((line) => distanceFrom(line, -1, true));
    expect(intro).toEqual([1, 2, 3, 4]);
    // Distinct colours, and none of them the accent reserved for the line being sung.
    const colors = intro.map(colorFor);
    expect(new Set(colors).size).toBeGreaterThan(1);
    expect(colors).not.toContain(colorFor(0));
  });

  test("the first line brightens rather than the rest dimming when singing starts", () => {
    // The same line, an instant before and after it begins.
    expect(colorFor(distanceFrom(0, -1, true))).toBe(colorFor(1));
    expect(colorFor(distanceFrom(0, 0, true))).toBe(colorFor(0));
    // Everything below it is unchanged by the transition.
    expect(distanceFrom(3, -1, true)).toBe(4);
    expect(distanceFrom(3, 0, true)).toBe(3);
  });

  // Nothing knows where an unsynced lyric is in the song, so a gradient would imply a position that
  // does not exist.
  test("an unsynced lyric is held at one weight", () => {
    const weights = [0, 1, 5, 40].map((line) => distanceFrom(line, -1, false));
    expect(new Set(weights).size).toBe(1);
    expect(colorFor(weights[0]!)).not.toBe(colorFor(0));
  });

  test("lines already sung fade faster than lines still coming", () => {
    expect(colorFor(-1)).toBe(colorFor(2));
    expect(colorFor(1)).not.toBe(colorFor(-1));
  });

  test("the sung line is the only one at full accent", () => {
    expect(colorFor(0)).not.toBe(colorFor(1));
    expect(colorFor(0)).not.toBe(colorFor(-1));
  });
});

describe("fadeProgress", () => {
  const lines = [
    { text: "first", atMs: 0 },
    { text: "second", atMs: 10_000 },
  ];

  test("runs from nothing to settled across the transition", () => {
    expect(fadeProgress(lines, 1, 10_000)).toBe(0);
    expect(fadeProgress(lines, 1, 10_075)).toBeCloseTo(0.5, 2);
    expect(fadeProgress(lines, 1, 10_150)).toBe(1);
  });

  test("stays settled for the rest of the line", () => {
    expect(fadeProgress(lines, 1, 12_000)).toBe(1);
  });

  /**
   * Derived from position rather than tracked in state, so seeking cannot strand a half-applied
   * fade: landing anywhere past the transition simply has nothing to animate.
   */
  test("has nothing to animate after a seek into the middle of a line", () => {
    expect(fadeProgress(lines, 0, 7_000)).toBe(1);
  });

  test("is settled during the intro and for an unstamped line", () => {
    expect(fadeProgress(lines, -1, 0)).toBe(1);
    expect(fadeProgress([{ text: "a", atMs: null }], 0, 500)).toBe(1);
  });
});
