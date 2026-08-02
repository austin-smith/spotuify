import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { Track } from "../src/api/types.ts";
import { useQueue } from "../src/store/queue.ts";
import { QueueView, queueListHeight } from "../src/ui/QueueView.tsx";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  useQueue.setState({
    open: false,
    nowPlaying: null,
    upNext: [],
    loading: false,
    error: null,
    notice: null,
    offset: 0,
  });
});

/** Identifiable up-next items, so rendered rows can be counted in the captured frame. */
function item(n: number, name = `Item ${String(n).padStart(2, "0")}`): Track {
  return {
    id: `t${n}`,
    name,
    uri: `spotify:track:t${n}`,
    duration_ms: 60_000,
    artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
    album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
  };
}

async function fill(
  width: number,
  height: number,
  options: { nowPlaying: boolean; count: number },
): Promise<{ frame: string[]; rows: string[] }> {
  useQueue.setState({
    open: true,
    // A distinct name, so the now-playing row can never be miscounted as an up-next item.
    nowPlaying: options.nowPlaying ? item(0, "Current Song") : null,
    upNext: Array.from({ length: options.count }, (_, i) => item(i + 1)),
    loading: false,
    error: null,
    offset: 0,
  });

  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(<QueueView width={width} height={height} />);
  await Bun.sleep(20);
  await setup.renderOnce();

  const frame = setup.captureCharFrame().split("\n");
  return { frame, rows: frame.filter((line) => /Item \d\d/.test(line)) };
}

const SIZES: number[] = [20, 24, 32, 40];

/**
 * `queueListHeight` checked against the renderer, the way `overlayListHeight` is pinned: its
 * hand-counted rows drift silently when the view changes — the old code clipped its last item.
 */
describe("queueListHeight", () => {
  test.each(SIZES)("every item it promises at height %i is drawn", async (height) => {
    const state = { nowPlaying: item(0), upNext: [item(1)] };
    const claimed = queueListHeight(height, state);
    const { rows } = await fill(60, height, { nowPlaying: true, count: claimed + 10 });
    expect(rows).toHaveLength(claimed);
  });

  test.each(SIZES)("no two items collide at height %i", async (height) => {
    const claimed = queueListHeight(height, { nowPlaying: item(0), upNext: [item(1)] });
    const { rows } = await fill(60, height, { nowPlaying: true, count: claimed + 10 });
    expect(rows.every((line) => (line.match(/Item \d\d/g) ?? []).length === 1)).toBe(true);
    expect(new Set(rows.map((line) => line.match(/Item \d\d/)?.[0])).size).toBe(claimed);
  });

  test.each(SIZES)("the frame still fits height %i", async (height) => {
    const claimed = queueListHeight(height, { nowPlaying: item(0), upNext: [item(1)] });
    const { frame } = await fill(60, height, { nowPlaying: true, count: claimed + 10 });
    expect(frame.filter((line) => line.length > 0).length).toBeLessThanOrEqual(height);
  });

  test("reclaims the now-playing rows when nothing is playing", async () => {
    const claimed = queueListHeight(24, { nowPlaying: null, upNext: [item(1)] });
    const { frame, rows } = await fill(60, 24, { nowPlaying: false, count: claimed + 10 });
    expect(rows).toHaveLength(claimed);
    expect(frame.some((line) => line.includes("NOW PLAYING"))).toBe(false);
  });

  test("the up-next header is drawn, not clipped by the items it makes room for", async () => {
    const claimed = queueListHeight(24, { nowPlaying: item(0), upNext: [item(1)] });
    const { frame } = await fill(60, 24, { nowPlaying: true, count: claimed + 10 });
    expect(frame.some((line) => line.includes("UP NEXT"))).toBe(true);
    expect(frame.some((line) => line.includes("Current Song"))).toBe(true);
  });
});
