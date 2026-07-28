import { createHash, randomBytes } from "node:crypto";
import { AUTHORIZE_URL } from "../config.ts";

/** Base64url encode without padding (RFC 7636 uses this for the challenge). */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * A random URL-safe string of `bytes` entropy. base64url's alphabet (A-Za-z0-9-_) is a subset of
 * the `unreserved` characters RFC 7636 allows in a code verifier, so no extra filtering is needed.
 */
export function randomUrlSafe(bytes: number): string {
  return base64url(randomBytes(bytes));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A code verifier / S256 challenge pair. 32 bytes yields a 43-char verifier — the RFC minimum. */
export function createPkce(): Pkce {
  const verifier = randomUrlSafe(32);
  return { verifier, challenge: challengeFor(verifier) };
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  challenge: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: params.challenge,
    state: params.state,
  }).toString();
  return url.toString();
}
