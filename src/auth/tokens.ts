import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { TOKEN_PATH, TOKEN_URL } from "../config.ts";

export interface StoredToken {
  accessToken: string;
  /** Absent when Spotify issues a token without one; such a token cannot be renewed. */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
}

/** Raised when the only way forward is a fresh interactive authorization. */
export class ReauthRequiredError extends Error {
  constructor(reason: string) {
    super(`${reason} Run \`spotuify auth\` to sign in again.`);
    this.name = "ReauthRequiredError";
  }
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** Refresh this far before actual expiry so an in-flight request never races the deadline. */
const REFRESH_MARGIN_MS = 60_000;

function toStoredToken(res: TokenResponse, previous?: StoredToken): StoredToken {
  const token: StoredToken = {
    accessToken: res.access_token,
    expiresAt: Date.now() + res.expires_in * 1000,
    scopes: res.scope ? res.scope.split(" ") : (previous?.scopes ?? []),
  };
  // Spotify omits refresh_token on some refresh responses; keep the one we already hold.
  const refreshToken = res.refresh_token ?? previous?.refreshToken;
  if (refreshToken !== undefined) token.refreshToken = refreshToken;
  return token;
}

interface OAuthError {
  error?: string;
  error_description?: string;
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function postForm(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    const parsed = parseJson<OAuthError>(text);
    const detail = parsed?.error_description ?? parsed?.error ?? text;
    // `invalid_grant` means the refresh token is dead — expired, revoked, or already rotated.
    if (parsed?.error === "invalid_grant") {
      throw new ReauthRequiredError(`Spotify rejected the grant (${detail}).`);
    }
    throw new Error(`Token request failed (${res.status}): ${detail}`);
  }

  const token = parseJson<TokenResponse>(text);
  if (token === null) throw new Error("Token endpoint returned a non-JSON response.");
  return token;
}

/** Exchange an authorization code for a token pair (PKCE — no client secret). */
export async function exchangeCode(params: {
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<StoredToken> {
  return toStoredToken(
    await postForm({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.verifier,
    }),
  );
}

/**
 * Persists the token pair and hands out valid access tokens, refreshing on demand.
 *
 * Concurrent callers share a single in-flight refresh so a burst of API calls cannot trigger a
 * stampede of token requests (and the rotation races that would follow).
 */
export class TokenStore {
  private token: StoredToken | null = null;
  private loaded = false;
  private inFlight: Promise<StoredToken> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly path: string = TOKEN_PATH,
  ) {}

  async load(): Promise<StoredToken | null> {
    if (this.loaded) return this.token;
    const file = Bun.file(this.path);
    if (await file.exists()) {
      try {
        this.token = (await file.json()) as StoredToken;
      } catch {
        // A corrupt cache should send us through re-auth, not crash startup.
        this.token = null;
      }
    }
    this.loaded = true;
    return this.token;
  }

  async save(token: StoredToken): Promise<void> {
    this.token = token;
    this.loaded = true;
    await mkdir(dirname(this.path), { recursive: true });
    await Bun.write(this.path, `${JSON.stringify(token, null, 2)}\n`);
    // The refresh token is a long-lived credential; keep it owner-only.
    await chmod(this.path, 0o600);
  }

  /** A valid access token, refreshing if it is expired or about to be. */
  async accessToken(): Promise<string> {
    const token = await this.load();
    if (token === null) throw new ReauthRequiredError("Not authenticated.");
    if (Date.now() < token.expiresAt - REFRESH_MARGIN_MS) return token.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Force a refresh, coalescing concurrent callers onto one request. */
  async refresh(): Promise<StoredToken> {
    if (this.inFlight !== null) return this.inFlight;

    this.inFlight = (async () => {
      const current = await this.load();
      if (current?.refreshToken === undefined) {
        throw new ReauthRequiredError("No refresh token is available.");
      }
      const refreshed = toStoredToken(
        await postForm({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: this.clientId,
        }),
        current,
      );
      await this.save(refreshed);
      return refreshed;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}
