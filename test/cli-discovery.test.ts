import { describe, expect, test } from "bun:test";
import { runtimeLyricsTrack } from "../src/cli/operations/catalog.ts";

const runtimeItem = {
  type: "track",
  id: "t",
  uri: "spotify:track:t",
  name: "Fake Empire",
  artists: ["The National"],
  artist: "The National",
  album: "Boxer",
  show: null,
  durationMs: 200_000,
};

describe("runtimeLyricsTrack", () => {
  test("narrows the runtime's current track for lyric lookup", () => {
    const subject = runtimeLyricsTrack({ item: runtimeItem });
    expect(subject.name).toBe("Fake Empire");
    expect(subject.artists).toEqual(["The National"]);
    expect(subject.artist).toBe("The National");
    expect(subject.durationMs).toBe(200_000);
    expect(subject.record).toBe(runtimeItem);
  });

  test("joins artists when the display line is absent", () => {
    const subject = runtimeLyricsTrack({
      item: { ...runtimeItem, artist: undefined, artists: ["A", "B"] },
    });
    expect(subject.artist).toBe("A, B");
  });

  test("refuses episodes and empty playback alike", () => {
    expect(() =>
      runtimeLyricsTrack({ item: { ...runtimeItem, type: "episode" } }),
    ).toThrow("not a track");
    expect(() => runtimeLyricsTrack({ item: null })).toThrow("not a track");
    expect(() => runtimeLyricsTrack(null)).toThrow("not a track");
  });
});
