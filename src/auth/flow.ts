import { REDIRECT_URI, SCOPES, resolveClientId } from "../config.ts";
import { awaitAuthCode } from "./loopback.ts";
import { buildAuthorizeUrl, createPkce, randomUrlSafe } from "./pkce.ts";
import { TokenStore, exchangeCode, type StoredToken } from "./tokens.ts";

export type AuthenticationEvent =
  | { type: "cache-hit" }
  | { type: "token-refreshed" }
  | { type: "refresh-failed"; message: string }
  | { type: "authorization-required"; url: string; browserLaunchAttempted: boolean };

function reportAuthenticationEvent(event: AuthenticationEvent): void {
  switch (event.type) {
    case "cache-hit":
    case "token-refreshed":
      return;
    case "refresh-failed":
      console.error(`Could not refresh the cached token (${event.message})`);
      return;
    case "authorization-required":
      console.log(
        `${event.browserLaunchAttempted ? "Continue in" : "Open"} your browser to authorize spotuify.\n` +
          `If it does not open: ${event.url}\n`,
      );
  }
}

type BrowserProcess = { unref(): void };
type BrowserSpawner = (command: string[]) => BrowserProcess;

function spawnBrowser(command: string[]): BrowserProcess {
  return Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
}

/** Launch a browser without making OAuth wait for the opener or its browser process to exit. */
export function launchBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: BrowserSpawner = spawnBrowser,
): boolean {
  const command =
    platform === "darwin" ? ["open", url] : platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try {
    const child = spawn(command);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the full interactive Authorization Code + PKCE flow and cache the resulting token.
 *
 * Must not run while the TUI owns the terminal — it prints to stdout and waits on a browser.
 */
export async function authenticate(
  options: {
    force?: boolean;
    clientId?: string;
    onEvent?: (event: AuthenticationEvent) => void;
  } = {},
): Promise<StoredToken> {
  const clientId = options.clientId ?? (await resolveClientId());
  const store = new TokenStore(clientId);
  const onEvent = options.onEvent ?? reportAuthenticationEvent;

  if (options.force !== true) {
    const cached = await store.load();
    // A token with no refresh token is a dead end once it expires; re-authorize instead.
    if (cached !== null && cached.refreshToken !== undefined) {
      if (Date.now() < cached.expiresAt) {
        onEvent({ type: "cache-hit" });
        return cached;
      }
      try {
        const refreshed = await store.refresh();
        onEvent({ type: "token-refreshed" });
        return refreshed;
      } catch (err) {
        // Refresh tokens expire ~6 months after authorization. Fall through to the interactive
        // flow rather than failing.
        onEvent({
          type: "refresh-failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const { verifier, challenge } = createPkce();
  const state = randomUrlSafe(16);
  const url = buildAuthorizeUrl({
    clientId,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    challenge,
    state,
  });

  // Start the loopback listener before launching the browser so a fast redirect cannot win the
  // race against server startup.
  const authorizationCode = awaitAuthCode(state);
  const browserLaunchAttempted = launchBrowser(url);
  onEvent({ type: "authorization-required", url, browserLaunchAttempted });

  const code = await authorizationCode;
  const token = await exchangeCode({ clientId, code, redirectUri: REDIRECT_URI, verifier });
  await store.save(token);
  return token;
}

/** A `TokenStore` for the configured client, without running any interactive flow. */
export async function tokenStore(clientId?: string): Promise<TokenStore> {
  return new TokenStore(clientId ?? (await resolveClientId()));
}
