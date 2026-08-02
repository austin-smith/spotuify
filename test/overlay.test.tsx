import type { MouseEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { Overlay, overlayListHeight, scrollSteps } from "../src/ui/Overlay.tsx";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** Render `count` identifiable rows in the shell and report what actually reached the screen. */
async function fill(
  width: number,
  height: number,
  count: number,
  extraRows = 0,
): Promise<{ frame: string[]; rows: string[] }> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <Overlay
      width={width}
      height={height}
      header={<text>HEADER</text>}
      status="status"
      hints="hints"
    >
      {extraRows > 0 ? <text>extra</text> : null}
      {Array.from({ length: count }, (_, i) => (
        <box key={i} flexDirection="row">
          <text>{`row${String(i).padStart(2, "0")}`}</text>
        </box>
      ))}
    </Overlay>,
  );
  await Bun.sleep(20);
  await setup.renderOnce();

  const frame = setup.captureCharFrame().split("\n");
  return { frame, rows: frame.filter((line) => /row\d\d/.test(line)) };
}

const SIZES: number[] = [20, 24, 32, 40];

/**
 * The shell's row budget, checked against the renderer.
 *
 * This was wrong by one for a long time, and the failure mode is nasty: the renderer draws the last
 * two rows on top of each other, so a full list loses an entry and the row it collides with comes
 * out garbled. It looks like a font or encoding problem rather than a layout one, which is why it
 * survived — and why it is pinned here rather than left to a snapshot.
 */
describe("overlayListHeight", () => {
  test.each(SIZES)("every row it promises at height %i is drawn", async (height) => {
    const claimed = overlayListHeight(height);
    const { rows } = await fill(60, height, claimed);
    expect(rows).toHaveLength(claimed);
  });

  test.each(SIZES)("no two rows collide at height %i", async (height) => {
    const claimed = overlayListHeight(height);
    const { rows } = await fill(60, height, claimed);
    // Two rows sharing a line show up as two markers on one line, with the shorter one's characters
    // bleeding through the gaps in the longer.
    expect(rows.every((line) => (line.match(/row\d\d/g) ?? []).length === 1)).toBe(true);
    expect(new Set(rows.map((line) => line.match(/row\d\d/)?.[0])).size).toBe(claimed);
  });

  test.each(SIZES)("the frame still fits height %i", async (height) => {
    const { frame } = await fill(60, height, overlayListHeight(height));
    // `captureCharFrame` ends with a trailing newline, hence the empty last element.
    expect(frame.filter((line) => line.length > 0).length).toBeLessThanOrEqual(height);
  });

  test("accounts for rows an overlay adds above its list", async () => {
    const claimed = overlayListHeight(24, 1);
    const { rows, frame } = await fill(60, 24, claimed, 1);
    expect(rows).toHaveLength(claimed);
    expect(frame.some((line) => line.includes("extra"))).toBe(true);
  });

  test("never promises a negative number of rows", () => {
    expect(overlayListHeight(1)).toBeGreaterThanOrEqual(1);
    expect(overlayListHeight(0)).toBeGreaterThanOrEqual(1);
  });
});

/** Only the scroll fields matter to the helper; the rest of the renderer event is irrelevant. */
function wheel(scroll: { direction: string; delta?: number } | undefined): MouseEvent {
  return { scroll } as unknown as MouseEvent;
}

describe("scrollSteps", () => {
  test("signs the rows by direction", () => {
    expect(scrollSteps(wheel({ direction: "up", delta: 3 }))).toBe(-3);
    expect(scrollSteps(wheel({ direction: "down", delta: 3 }))).toBe(3);
  });

  test("a tick without a usable delta still moves one row", () => {
    expect(scrollSteps(wheel({ direction: "down" }))).toBe(1);
    expect(scrollSteps(wheel({ direction: "up", delta: 0 }))).toBe(-1);
    // Trackpads report fractional deltas; a partial tick is still a deliberate scroll.
    expect(scrollSteps(wheel({ direction: "down", delta: 0.4 }))).toBe(1);
  });

  test("ignores non-scroll mouse input", () => {
    expect(scrollSteps(wheel(undefined))).toBeNull();
    expect(scrollSteps(wheel({ direction: "left", delta: 2 }))).toBeNull();
  });
});
