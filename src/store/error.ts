import { SpotifyApiError } from "../api/client.ts";

/**
 * Turn an operation failure into a compact, user-facing status line.
 *
 * Spotify API errors keep their useful detail and status code, but not the endpoint-bearing
 * `Error.message`. Everything else retains its original message and uses the same presentation.
 */
export function failureMessage(action: string, error: unknown): string {
  const raw =
    error instanceof SpotifyApiError
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error);
  const detail = raw.trim().replace(/\.$/, "") || "Unknown error";
  const status = error instanceof SpotifyApiError ? ` (${error.status})` : "";
  return `Couldn’t ${action} · ${detail}${status}`;
}
