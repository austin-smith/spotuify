import { describe, expect, test } from "bun:test";
import { useLyrics } from "../src/store/lyrics.ts";
import { layoutLyrics } from "../src/ui/LyricsView.tsx";
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
