import { describe, expect, test } from "bun:test";
import {
  applyScrim,
  chooseImage,
  coverCrop,
  fitSquare,
  pixelDimsFor,
  regionAspect,
  resizeRgba,
} from "../src/ui/art.ts";

/** Build an RGBA buffer from a per-pixel colour function. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number]) {
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      const i = (y * w + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

describe("fitSquare", () => {
  // A supersampled cell is 1px wide and 2px tall, and cells are ~2x taller than wide, so a
  // visually square image needs twice as many columns as rows.
  test("returns twice as many columns as rows", () => {
    const { w, h } = fitSquare(80, 40);
    expect(w).toBe(h * 2);
  });

  test("is limited by width when width is the constraint", () => {
    expect(fitSquare(40, 100)).toEqual({ w: 40, h: 20 });
  });

  test("is limited by height when height is the constraint", () => {
    expect(fitSquare(200, 10)).toEqual({ w: 20, h: 10 });
  });

  test("never returns zero or negative dimensions", () => {
    for (const [w, h] of [[0, 0], [1, 1], [-5, 3], [3, 0]] as const) {
      const fit = fitSquare(w, h);
      expect(fit.h).toBeGreaterThanOrEqual(1);
      expect(fit.w).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("chooseImage", () => {
  const images = [
    { url: "small", width: 64, height: 64 },
    { url: "medium", width: 300, height: 300 },
    { url: "large", width: 640, height: 640 },
  ];

  // Oversamples 2x so the box filter has detail to average.
  test("picks a source at least twice the target edge", () => {
    expect(chooseImage(images, 32)?.url).toBe("small");
    expect(chooseImage(images, 33)?.url).toBe("medium");
    expect(chooseImage(images, 150)?.url).toBe("medium");
    expect(chooseImage(images, 151)?.url).toBe("large");
  });

  test("falls back to the largest when nothing is big enough", () => {
    expect(chooseImage(images, 5000)?.url).toBe("large");
  });

  test("still returns the largest when oversampling is unsatisfiable", () => {
    expect(chooseImage(images, 400)?.url).toBe("large");
  });

  test("returns null for no images", () => {
    expect(chooseImage([], 40)).toBeNull();
  });

  test("tolerates null widths", () => {
    expect(chooseImage([{ url: "unknown", width: null, height: null }], 40)?.url).toBe("unknown");
  });
});

describe("pixelDimsFor", () => {
  // drawSuperSampleBuffer samples a 2x2 pixel block per cell; supplying fewer pixels per row makes
  // it read into the next row and tile the image horizontally.
  test("is exactly twice the cell dimensions on both axes", () => {
    expect(pixelDimsFor(60, 30)).toEqual({ width: 120, height: 60 });
    expect(pixelDimsFor(1, 1)).toEqual({ width: 2, height: 2 });
  });

  test("stays 2:1 for a square-looking region", () => {
    const { w, h } = fitSquare(120, 60);
    const px = pixelDimsFor(w, h);
    expect(px.width / px.height).toBe(2);
  });
});

describe("resizeRgba", () => {
  test("produces exactly the requested pixel count", () => {
    const src = image(64, 64, () => [10, 20, 30]);
    expect(resizeRgba(src, 64, 64, 40, 20)).toHaveLength(40 * 20 * 4);
  });

  test("preserves a flat colour exactly", () => {
    const src = image(64, 64, () => [10, 20, 30]);
    const out = resizeRgba(src, 64, 64, 8, 8);
    expect([out[0], out[1], out[2], out[3]]).toEqual([10, 20, 30, 255]);
  });

  // Point-sampling a black/white checkerboard yields all-black or all-white; a box filter greys it.
  test("averages rather than point-samples", () => {
    const src = image(64, 64, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
    const out = resizeRgba(src, 64, 64, 8, 8);
    expect(out[0]).toBeGreaterThan(100);
    expect(out[0]).toBeLessThan(155);
  });

  test("always writes an opaque alpha channel", () => {
    const out = resizeRgba(image(16, 16, () => [1, 2, 3]), 16, 16, 4, 4);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });

  test("handles upscaling without reading out of bounds", () => {
    const out = resizeRgba(image(2, 2, () => [7, 8, 9]), 2, 2, 8, 8);
    expect(out).toHaveLength(8 * 8 * 4);
    expect([out[0], out[1], out[2]]).toEqual([7, 8, 9]);
  });
});

describe("regionAspect", () => {
  // A cell is ~2x taller than wide, so the visual aspect is not cols/rows.
  test("accounts for the 1:2 cell shape", () => {
    expect(regionAspect(100, 32)).toBeCloseTo(100 / 64, 5);
    expect(regionAspect(80, 24)).toBeCloseTo(80 / 48, 5);
  });

  test("never divides by zero", () => {
    expect(Number.isFinite(regionAspect(80, 0))).toBe(true);
  });
});

describe("coverCrop", () => {
  test("trims top and bottom when the source is too tall", () => {
    // Square cover into a landscape terminal: keep full width, crop vertically, stay centred.
    const crop = coverCrop(640, 640, 100 / 64);
    expect(crop.w).toBe(640);
    expect(crop.h).toBeLessThan(640);
    expect(crop.y).toBe(Math.floor((640 - crop.h) / 2));
    expect(crop.x).toBe(0);
  });

  test("trims the sides when the source is too wide", () => {
    const crop = coverCrop(1000, 200, 1);
    expect(crop.h).toBe(200);
    expect(crop.w).toBe(200);
    expect(crop.x).toBe(400);
  });

  test("returns the whole image when aspects already match", () => {
    expect(coverCrop(600, 300, 2)).toEqual({ x: 0, y: 0, w: 600, h: 300 });
  });

  test("never returns a rect outside the source", () => {
    for (const aspect of [0.2, 0.9, 1, 1.6, 4, 20]) {
      const crop = coverCrop(640, 640, aspect);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.w).toBeLessThanOrEqual(640);
      expect(crop.y + crop.h).toBeLessThanOrEqual(640);
      expect(crop.w).toBeGreaterThan(0);
      expect(crop.h).toBeGreaterThan(0);
    }
  });
});

describe("applyScrim", () => {
  const flat = (w: number, h: number) => {
    const buf = new Uint8Array(w * h * 4);
    buf.fill(200);
    return buf;
  };

  test("leaves rows above the ramp untouched", () => {
    const buf = flat(4, 20);
    applyScrim(buf, 4, 20, 16, 0.8, 4);
    expect(buf[0]).toBe(200);
  });

  test("darkens the bottom rows", () => {
    const buf = flat(4, 20);
    applyScrim(buf, 4, 20, 16, 0.8, 4);
    const lastRow = (19 * 4 + 0) * 4;
    expect(buf[lastRow]).toBeLessThan(60);
  });

  test("ramps rather than hard-edging", () => {
    const buf = flat(1, 20);
    applyScrim(buf, 1, 20, 16, 0.8, 4);
    const at = (y: number) => buf[y * 4] ?? 0;
    // Monotonically darker through the ramp — an abrupt band reads as a rendering fault.
    expect(at(13)).toBeGreaterThan(at(14));
    expect(at(14)).toBeGreaterThan(at(15));
    expect(at(15)).toBeGreaterThan(at(16));
  });

  test("never leaves alpha or out-of-range values", () => {
    const buf = flat(3, 12);
    applyScrim(buf, 3, 12, 6);
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBeGreaterThanOrEqual(0);
      expect(buf[i]).toBeLessThanOrEqual(255);
    }
  });
});
