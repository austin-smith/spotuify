import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl, challengeFor, createPkce, randomUrlSafe } from "../src/auth/pkce.ts";

describe("pkce", () => {
  test("matches the RFC 7636 Appendix B test vector", () => {
    // The canonical verifier/challenge pair from the RFC.
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("verifier satisfies the RFC length and charset rules", () => {
    const { verifier } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("challenge is base64url with no padding", () => {
    const { challenge } = createPkce();
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toContain("=");
  });

  test("each pair is unique", () => {
    const pairs = new Set(Array.from({ length: 50 }, () => createPkce().verifier));
    expect(pairs.size).toBe(50);
  });

  test("randomUrlSafe is url-safe", () => {
    expect(randomUrlSafe(16)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  test("authorize url carries every required parameter", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "abc123",
        redirectUri: "http://127.0.0.1:8989/callback",
        scopes: ["user-read-playback-state", "user-library-read"],
        challenge: "chal",
        state: "st",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("abc123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8989/callback");
    // Scopes are space-delimited per RFC 6749, which URLSearchParams encodes as `+`.
    expect(url.searchParams.get("scope")).toBe("user-read-playback-state user-library-read");
  });
});
