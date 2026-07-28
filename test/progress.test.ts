import { describe, expect, test } from "bun:test";
import {
  BAR_EMPTY,
  BAR_FILL,
  extrapolate,
  formatDuration,
  meter,
  progressBar,
} from "../src/store/progress.ts";

const anchor = (over: Partial<Parameters<typeof extrapolate>[0]> = {}) => ({
  progressMs: 30_000,
  atMs: 1_000,
  isPlaying: true,
  durationMs: 200_000,
  ...over,
});

describe("extrapolate", () => {
  test("advances while playing", () => {
    expect(extrapolate(anchor(), 1_000)).toBe(30_000);
    expect(extrapolate(anchor(), 6_000)).toBe(35_000);
  });

  test("stays put while paused", () => {
    expect(extrapolate(anchor({ isPlaying: false }), 60_000)).toBe(30_000);
  });

  test("clamps to the track duration", () => {
    // Well past the end of a 200s track.
    expect(extrapolate(anchor(), 500_000)).toBe(200_000);
  });

  test("never goes negative", () => {
    expect(extrapolate(anchor({ progressMs: 0 }), 0)).toBe(0);
  });

  // A clock that appears to move backwards must not rewind the bar.
  test("ignores a backwards clock", () => {
    expect(extrapolate(anchor(), 0)).toBe(30_000);
  });

  test("tolerates an unknown duration", () => {
    expect(extrapolate(anchor({ durationMs: 0 }), 6_000)).toBe(35_000);
  });
});

describe("formatDuration", () => {
  test.each([
    [0, "0:00"],
    [1_000, "0:01"],
    [59_999, "0:59"],
    [60_000, "1:00"],
    [125_000, "2:05"],
    [3_600_000, "60:00"],
  ])("%i ms renders as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  test("clamps negatives", () => {
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("progressBar", () => {
  test("is always exactly the requested width", () => {
    for (const progress of [0, 1, 5_000, 99_999, 100_000]) {
      expect(progressBar(progress, 100_000, 20)).toHaveLength(20);
    }
  });

  test("renders empty at the start and full at the end", () => {
    expect(progressBar(0, 100_000, 10)).toBe(BAR_EMPTY.repeat(10));
    expect(progressBar(100_000, 100_000, 10)).toBe(BAR_FILL.repeat(10));
  });

  test("renders half at the midpoint", () => {
    expect(progressBar(50_000, 100_000, 10)).toBe(BAR_FILL.repeat(5) + BAR_EMPTY.repeat(5));
  });

  test("accepts custom characters", () => {
    expect(progressBar(50_000, 100_000, 4, "#", ".")).toBe("##..");
  });

  test("handles an unknown duration without dividing by zero", () => {
    expect(progressBar(5_000, 0, 10)).toBe(BAR_EMPTY.repeat(10));
  });

  test("returns empty for a nonpositive width", () => {
    expect(progressBar(5_000, 10_000, 0)).toBe("");
  });
});

describe("meter", () => {
  test("is always exactly the requested width", () => {
    for (const v of [0, 1, 50, 99, 100]) expect(meter(v, 100, 10)).toHaveLength(10);
  });

  test("renders empty, half and full", () => {
    expect(meter(0, 100, 10)).toBe(BAR_EMPTY.repeat(10));
    expect(meter(50, 100, 10)).toBe(BAR_FILL.repeat(5) + BAR_EMPTY.repeat(5));
    expect(meter(100, 100, 10)).toBe(BAR_FILL.repeat(10));
  });

  test("clamps out-of-range values", () => {
    expect(meter(-10, 100, 4)).toBe(BAR_EMPTY.repeat(4));
    expect(meter(500, 100, 4)).toBe(BAR_FILL.repeat(4));
  });

  test("returns empty for a nonpositive width or max", () => {
    expect(meter(50, 100, 0)).toBe("");
    expect(meter(50, 0, 10)).toBe("");
  });
});
