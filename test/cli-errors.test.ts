import { describe, expect, test } from "bun:test";
import { SpotifyApiError, SpotifyLimitError } from "../src/api/client.ts";
import { asCliError } from "../src/cli/errors.ts";

describe("CLI errors", () => {
  test("keeps API endpoint internals out of user-facing failures", () => {
    const forbidden = asCliError(
      new SpotifyApiError(403, "/me/player/queue", "Forbidden"),
    );
    expect(forbidden.message).toBe("Forbidden");
    expect(forbidden.message).not.toContain("/me/player");

    const missing = asCliError(
      new SpotifyApiError(404, "/playlists/private/items", "Not found"),
    );
    expect(missing.message).toBe("Spotify resource not found.");
  });

  test("preserves rate-limit timing without exposing its endpoint", () => {
    const retryAt = Date.now() + 60_000;
    const error = asCliError(
      new SpotifyLimitError("/me", "Rate limited", null, retryAt),
    );
    expect(error.message).toBe("Rate limited");
    expect(error.hint).toContain(new Date(retryAt).toISOString());
    expect(error.exitCode).toBe(6);
  });
});
