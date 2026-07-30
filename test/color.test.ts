import { describe, expect, test } from "bun:test";
import { easeOut, lerpColor } from "../src/ui/color.ts";

describe("lerpColor", () => {
  test("returns the ends exactly", () => {
    expect(lerpColor("#000000", "#ffffff", 0)).toBe("#000000");
    expect(lerpColor("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  test("blends the middle", () => {
    expect(lerpColor("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("moves each channel independently", () => {
    expect(lerpColor("#ff0000", "#0000ff", 0.5)).toBe("#800080");
  });

  test("is monotonic across the range", () => {
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const value = Number.parseInt(lerpColor("#000000", "#ffffff", t).slice(1, 3), 16);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test("clamps rather than extrapolating past the ends", () => {
    expect(lerpColor("#101010", "#202020", -5)).toBe("#101010");
    expect(lerpColor("#101010", "#202020", 5)).toBe("#202020");
  });

  // The endpoints return their input verbatim, so a blend is what actually exercises the parser.
  test("understands the short form", () => {
    expect(lerpColor("#000", "#fff", 0.5)).toBe("#808080");
    expect(lerpColor("#f00", "#f00", 0.5)).toBe("#ff0000");
  });

  test("always produces a valid color", () => {
    for (let t = 0; t <= 1; t += 0.017) {
      expect(lerpColor("#1ed760", "#3a3a42", t)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // Rendering an unparseable color as black would be a far worse failure than ignoring the blend.
  test("passes an unparseable color through instead of rendering black", () => {
    expect(lerpColor("rebeccapurple", "#ffffff", 0.2)).toBe("rebeccapurple");
    expect(lerpColor("rebeccapurple", "#ffffff", 0.8)).toBe("#ffffff");
  });
});

describe("easeOut", () => {
  test("keeps the ends fixed", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });

  // Front-loading the movement is what makes it read as settling rather than being dragged.
  test("front-loads the movement", () => {
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(0.25)).toBeGreaterThan(0.25);
  });

  test("never goes backwards", () => {
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const value = easeOut(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test("clamps out-of-range input", () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(2)).toBe(1);
  });
});
