import { describe, expect, test } from "bun:test";
import {
  durationMs,
  signedDurationMs,
  signedPercent,
  spotifyReference,
  timestampMs,
} from "../src/cli/values.ts";
import { targetDevice } from "../src/cli/support.ts";

describe("CLI values", () => {
  test("normalizes Spotify URIs, URLs, international URLs, and typed IDs", () => {
    expect(spotifyReference("spotify:track:abc123")).toEqual({
      kind: "track",
      id: "abc123",
      uri: "spotify:track:abc123",
    });
    expect(
      spotifyReference(
        "https://open.spotify.com/intl-de/album/xyz789?si=ignored",
      ),
    ).toEqual({ kind: "album", id: "xyz789", uri: "spotify:album:xyz789" });
    expect(spotifyReference("playlistId", "playlist")).toEqual({
      kind: "playlist",
      id: "playlistId",
      uri: "spotify:playlist:playlistId",
    });
  });

  test("rejects a resource whose type does not match the command", () => {
    expect(() => spotifyReference("spotify:album:abc", "track")).toThrow(
      "Expected a Spotify track",
    );
  });

  test("rejects IDs and URL paths that could change the API endpoint", () => {
    expect(() =>
      spotifyReference("spotify:playlist:../me/player/pause"),
    ).toThrow("Invalid Spotify URI");
    expect(() =>
      spotifyReference("https://open.spotify.com/playlist/abc/extra"),
    ).toThrow("Invalid Spotify URI");
  });

  test("parses standard time forms without ambiguity", () => {
    expect(durationMs("90")).toBe(90_000);
    expect(durationMs("1:30")).toBe(90_000);
    expect(durationMs("1:02:03")).toBe(3_723_000);
    expect(durationMs("1h2m3s")).toBe(3_723_000);
    expect(signedDurationMs("-30s")).toEqual({
      relative: true,
      milliseconds: -30_000,
    });
  });

  test("distinguishes absolute and relative volume", () => {
    expect(signedPercent("75%")).toEqual({ relative: false, percent: 75 });
    expect(signedPercent("+5")).toEqual({ relative: true, percent: 5 });
    expect(() => signedPercent("101")).toThrow("between 0 and 100");
  });

  test("refuses to target a device without a usable ID", () => {
    expect(() =>
      targetDevice(
        [
          {
            id: null,
            name: "Unavailable speaker",
            type: "Speaker",
            is_active: false,
            is_restricted: false,
            volume_percent: 50,
          },
        ],
        "Unavailable speaker",
      ),
    ).toThrow("no usable ID");
  });
});

describe("timestampMs", () => {
  test("accepts ISO 8601 date-times", () => {
    expect(timestampMs("2026-08-01T12:00:00Z", "before")).toBe(
      Date.parse("2026-08-01T12:00:00Z"),
    );
  });

  test("accepts epoch milliseconds verbatim", () => {
    expect(timestampMs("1754049600000", "after")).toBe(1_754_049_600_000);
  });

  test("rejects text that is neither, naming the option", () => {
    expect(() => timestampMs("yesterday", "before")).toThrow("Invalid before");
  });
});
