import { beforeEach, describe, expect, test } from "bun:test";
import { useQueue } from "../src/store/queue.ts";
import type { Track } from "../src/api/types.ts";

function track(n: number): Track {
  return {
    id: `t${n}`,
    name: `Track ${n}`,
    uri: `spotify:track:t${n}`,
    duration_ms: 60_000,
    artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
    album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
  };
}

const queueOf = (count: number): Track[] =>
  Array.from({ length: count }, (_, i) => track(i + 1));

beforeEach(() => {
  useQueue.setState({
    open: true,
    nowPlaying: null,
    upNext: queueOf(30),
    loading: false,
    error: null,
    notice: null,
    offset: 0,
  });
});

describe("queue scrolling", () => {
  test("scrolls within the list and stops at both ends", () => {
    useQueue.getState().scrollBy(5, 10);
    expect(useQueue.getState().offset).toBe(5);

    useQueue.getState().scrollBy(-50, 10);
    expect(useQueue.getState().offset).toBe(0);

    // Never past the point where the last item reaches the bottom of the viewport.
    useQueue.getState().scrollBy(500, 10);
    expect(useQueue.getState().offset).toBe(20);
  });

  test("jumps to either edge", () => {
    useQueue.getState().scrollToEdge("bottom", 10);
    expect(useQueue.getState().offset).toBe(20);

    useQueue.getState().scrollToEdge("top", 10);
    expect(useQueue.getState().offset).toBe(0);
  });

  test("a queue that fits on screen does not scroll", () => {
    useQueue.setState({ upNext: queueOf(5) });
    useQueue.getState().scrollBy(3, 10);
    expect(useQueue.getState().offset).toBe(0);
    useQueue.getState().scrollToEdge("bottom", 10);
    expect(useQueue.getState().offset).toBe(0);
  });

  // A refresh can shrink the queue underneath a scrolled view; the view reports its height back so
  // the position lands inside whatever remains rather than on blank rows.
  test("clamping after a shrink keeps the position inside the list", () => {
    useQueue.getState().scrollToEdge("bottom", 10);
    expect(useQueue.getState().offset).toBe(20);

    useQueue.setState({ upNext: queueOf(12) });
    useQueue.getState().clampOffset(10);
    expect(useQueue.getState().offset).toBe(2);
  });

  test("reopening starts from the top", () => {
    useQueue.getState().scrollBy(7, 10);
    useQueue.getState().closeQueue();
    expect(useQueue.getState().offset).toBe(0);

    useQueue.getState().scrollBy(7, 10);
    useQueue.getState().openQueue();
    expect(useQueue.getState().offset).toBe(0);
  });
});
