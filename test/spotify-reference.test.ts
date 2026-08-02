import { describe, expect, test } from "bun:test";
import {
  looksLikeSpotifyReference,
  parseSpotifyReference,
  spotifyOpenUrl,
} from "../src/spotify/reference.ts";

const ID = "4uLU6hMCjMI75M1A2tKUQC";

describe("parseSpotifyReference", () => {
  test("normalizes a complete Spotify URI", () => {
    expect(parseSpotifyReference(`spotify:track:${ID}`)).toEqual({
      type: "track",
      id: ID,
      uri: `spotify:track:${ID}`,
      url: `https://open.spotify.com/track/${ID}`,
    });
  });

  test("normalizes share URLs and discards tracking parameters", () => {
    expect(parseSpotifyReference(`https://open.spotify.com/album/${ID}?si=secret`)?.uri).toBe(
      `spotify:album:${ID}`,
    );
  });

  test("accepts Spotify's localized share paths", () => {
    expect(parseSpotifyReference(`https://open.spotify.com/intl-de/artist/${ID}`)?.uri).toBe(
      `spotify:artist:${ID}`,
    );
  });

  test("requires the entire value to be a reference", () => {
    expect(parseSpotifyReference(`play spotify:track:${ID}`)).toBeNull();
    expect(parseSpotifyReference(`https://open.spotify.com/track/${ID}/extra`)).toBeNull();
  });

  test("rejects look-alike hosts, credentials, insecure URLs and malformed ids", () => {
    expect(parseSpotifyReference(`https://open.spotify.com.evil.test/track/${ID}`)).toBeNull();
    expect(parseSpotifyReference(`https://user@open.spotify.com/track/${ID}`)).toBeNull();
    expect(parseSpotifyReference(`http://open.spotify.com/track/${ID}`)).toBeNull();
    expect(parseSpotifyReference("spotify:track:short")).toBeNull();
  });
});

describe("Spotify reference helpers", () => {
  test("recognizes incomplete references without treating ordinary queries as links", () => {
    expect(looksLikeSpotifyReference("spotify:album:")).toBeTrue();
    expect(looksLikeSpotifyReference("https://open.spotify.com/track/")).toBeTrue();
    expect(looksLikeSpotifyReference("spotify playlist mix")).toBeFalse();
  });

  test("creates a canonical open.spotify.com URL from a URI", () => {
    expect(spotifyOpenUrl(`spotify:playlist:${ID}`)).toBe(
      `https://open.spotify.com/playlist/${ID}`,
    );
  });
});
