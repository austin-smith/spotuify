import { randomUUID } from "node:crypto";
import { TOKEN_PATH, TOKEN_URL } from "../config.ts";
import { writePrivateFileAtomic } from "./private-file.ts";

export interface StoredToken {
  accessToken: string;
  /** Absent when Spotify issues a token without one; such a token cannot be renewed. */
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scopes: string[];
  /**
   * Stable identity for one interactive authorization. It changes on reauthorization and survives
   * access/refresh-token rotation, so account-derived caches cannot cross authorization boundaries.
   */
  authorizationId: string;
  /** The Spotify application that issued this credential set. */
  clientId: string;
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

function toStoredToken(
  res: TokenResponse,
  clientId: string,
  previous?: StoredToken,
): StoredToken {
  const token: StoredToken = {
    accessToken: res.access_token,
    expiresAt: Date.now() + res.expires_in * 1000,
    scopes: res.scope ? res.scope.split(" ") : (previous?.scopes ?? []),
    authorizationId: previous?.authorizationId ?? randomUUID(),
    clientId,
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
    params.clientId,
  );
}

function parseStoredToken(value: unknown, clientId: string): StoredToken | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<StoredToken>;
  if (
    typeof candidate.accessToken !== "string" ||
    typeof candidate.expiresAt !== "number" ||
    !Number.isFinite(candidate.expiresAt) ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.every((scope) => typeof scope === "string") ||
    (candidate.refreshToken !== undefined && typeof candidate.refreshToken !== "string")
  ) {
    return null;
  }
  if (candidate.clientId !== undefined && candidate.clientId !== clientId) return null;

  return {
    accessToken: candidate.accessToken,
    ...(candidate.refreshToken !== undefined ? { refreshToken: candidate.refreshToken } : {}),
    expiresAt: candidate.expiresAt,
    scopes: candidate.scopes,
    // Legacy token caches receive a new local identity. Legacy profiles are deliberately not
    // migrated, so no account data can be associated with this identity until `/me` succeeds.
    authorizationId:
      typeof candidate.authorizationId === "string" && candidate.authorizationId.length > 0
        ? candidate.authorizationId
        : randomUUID(),
    clientId,
  };
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
        const cached = (await file.json()) as unknown;
        this.token = parseStoredToken(cached, this.clientId);
        if (
          this.token !== null &&
          (typeof (cached as Partial<StoredToken>).authorizationId !== "string" ||
            (cached as Partial<StoredToken>).authorizationId?.length === 0 ||
            (cached as Partial<StoredToken>).clientId !== this.clientId)
        ) {
          // Migration metadata improves cache isolation, but a read-only or full filesystem must
          // not invalidate a credential that was already parsed successfully.
          await this.persist(this.token).catch(() => {});
        }
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
    await this.persist(token);
  }

  private async persist(token: StoredToken): Promise<void> {
    await writePrivateFileAtomic(this.path, `${JSON.stringify(token, null, 2)}\n`);
  }

  /** Identity of the current authorization, used to bind account-derived caches. */
  async authorizationId(): Promise<string> {
    const token = await this.load();
    if (token === null) throw new ReauthRequiredError("Not authenticated.");
    return token.authorizationId;
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
        this.clientId,
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
