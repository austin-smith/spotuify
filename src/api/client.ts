import { API_BASE } from "../config.ts";
import type { TokenStore } from "../auth/tokens.ts";

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Spotify's own message, without the status and path this prefixes onto it. */
    readonly detail: string,
  ) {
    super(`Spotify API ${status} on ${path}: ${detail}`);
    this.name = "SpotifyApiError";
  }
}

/**
 * Spotify declined a transport command as inapplicable.
 *
 * `403 Player command failed: …` is an outcome, not a fault: pressing previous at the start of a
 * context answers `Restriction violated`, which is Spotify's way of saying there is nothing to go
 * back to, and its own clients simply do nothing. Typed separately so callers can ignore it instead
 * of reporting a failure the user cannot act on.
 */
export class PlayerCommandRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PlayerCommandRejectedError";
  }
}

/** Playback control returns 403 for free accounts and when no device is active. */
export class PremiumRequiredError extends Error {
  constructor() {
    super("This action requires Spotify Premium.");
    this.name = "PremiumRequiredError";
  }
}

export interface RequestOptions {
  method?: string;
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 3;

/**
 * Authenticated Spotify Web API client.
 *
 * Handles the three failure modes that matter for a long-running TUI: an access token that expires
 * mid-session (401 → refresh → retry once), rate limiting (429 → honour `Retry-After`), and the
 * 204-with-no-body responses the player endpoints return on success.
 */
export class SpotifyClient {
  constructor(private readonly tokens: TokenStore) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let refreshed = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const accessToken = await this.tokens.accessToken();
      const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
      if (options.body !== undefined) headers["content-type"] = "application/json";

      const res = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (res.status === 204 || res.headers.get("content-length") === "0") return null;

      if (res.ok) {
        const text = await res.text();
        // Only a body Spotify labels as JSON is parsed as JSON. The transport endpoints answer 200
        // with a bare command id and no content-type at all — `next` returns something like
        // `xnhCFLSU-oYEeK59yBVw1tAwgNI` — and parsing that threw a raw SyntaxError that surfaced as
        // a failure on every keypress, even though the command had succeeded.
        if (text.length === 0 || !isJson(res)) return null;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new SpotifyApiError(res.status, path, "Response was not valid JSON.");
        }
      }

      // Expired or revoked token: refresh once, then retry with the new one.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.refresh();
        continue;
      }

      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        await Bun.sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
        continue;
      }

      const message = await errorMessage(res);
      if (res.status === 403 && /premium/i.test(message)) throw new PremiumRequiredError();
      // "Player command failed: Restriction violated" and friends: the command did not apply, which
      // is a normal outcome rather than something to report.
      if (res.status === 403 && /^player command failed/i.test(message)) {
        throw new PlayerCommandRejectedError(message.replace(/^player command failed:\s*/i, ""));
      }
      throw new SpotifyApiError(res.status, path, message);
    }

    throw new SpotifyApiError(429, path, "Rate limited; retries exhausted.");
  }

  /** `request` for endpoints that always return a body. */
  async get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    const result = await this.request<T>(path, query ? { query } : {});
    if (result === null) throw new SpotifyApiError(204, path, "Expected a response body.");
    return result;
  }
}

/** Whether Spotify labelled the body as JSON. Transport commands send no content-type at all. */
function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? res.statusText;
  } catch {
    return text.length > 0 ? text : res.statusText;
  }
}
