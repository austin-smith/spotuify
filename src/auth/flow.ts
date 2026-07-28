import { REDIRECT_URI, SCOPES, resolveClientId } from "../config.ts";
import { awaitAuthCode } from "./loopback.ts";
import { buildAuthorizeUrl, createPkce, randomUrlSafe } from "./pkce.ts";
import { TokenStore, exchangeCode, type StoredToken } from "./tokens.ts";

/** Open a URL in the user's browser, ignoring failure — the URL is always printed as a fallback. */
async function openBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  try {
    await Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {
    // No browser available (headless/SSH); the printed URL is the fallback.
  }
}

/**
 * Run the full interactive Authorization Code + PKCE flow and cache the resulting token.
 *
 * Must not run while the TUI owns the terminal — it prints to stdout and waits on a browser.
 */
export async function authenticate(options: { force?: boolean } = {}): Promise<StoredToken> {
  const clientId = await resolveClientId();
  const store = new TokenStore(clientId);

  if (options.force !== true) {
    const cached = await store.load();
    // A token with no refresh token is a dead end once it expires; re-authorize instead.
    if (cached !== null && cached.refreshToken !== undefined) {
      if (Date.now() < cached.expiresAt) return cached;
      try {
        return await store.refresh();
      } catch (err) {
        // Refresh tokens expire ~6 months after authorization. Fall through to the interactive
        // flow rather than failing.
        console.error(
          `Could not refresh the cached token (${err instanceof Error ? err.message : String(err)})`,
        );
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

  console.log(`Opening your browser to authorize spotuify.\nIf it does not open: ${url}\n`);
  void openBrowser(url);

  const code = await awaitAuthCode(state);
  const token = await exchangeCode({ clientId, code, redirectUri: REDIRECT_URI, verifier });
  await store.save(token);
  return token;
}

/** A `TokenStore` for the configured client, without running any interactive flow. */
export async function tokenStore(): Promise<TokenStore> {
  return new TokenStore(await resolveClientId());
}
