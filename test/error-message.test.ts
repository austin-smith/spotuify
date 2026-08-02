import { describe, expect, test } from "bun:test";
import { SpotifyApiError } from "../src/api/client.ts";
import { failureMessage } from "../src/store/error.ts";

describe("failure messages", () => {
  test("keeps API detail and status without exposing the endpoint", () => {
    const message = failureMessage(
      "load this item",
      new SpotifyApiError(404, "/playlists/playlist-id", "Resource not found"),
    );

    expect(message).toBe("Couldn’t load this item · Resource not found (404)");
    expect(message).not.toContain("/playlists/playlist-id");
    expect(message).not.toContain("Spotify API");
  });

  test("uses the same shape for ordinary errors without inventing a status", () => {
    expect(failureMessage("search", new Error("Connection failed."))).toBe(
      "Couldn’t search · Connection failed",
    );
  });
});
