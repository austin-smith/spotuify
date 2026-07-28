import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReauthRequiredError, TokenStore, type StoredToken } from "../src/auth/tokens.ts";

const realFetch = globalThis.fetch;
let dir: string;
let tokenPath: string;

/** Replace `fetch` with a queue of canned token-endpoint responses; returns the call log. */
function stubFetch(responses: Array<{ status: number; body: unknown }>): Array<URLSearchParams> {
  const calls: Array<URLSearchParams> = [];
  let i = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body ?? "")));
    const next = responses[i++];
    if (next === undefined) throw new Error("unexpected extra fetch call");
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return calls;
}

const store = () => new TokenStore("client-id", tokenPath);

const token = (over: Partial<StoredToken> = {}): StoredToken => ({
  accessToken: "old-access",
  refreshToken: "refresh-1",
  expiresAt: Date.now() + 3_600_000,
  scopes: ["user-library-read"],
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spotuify-test-"));
  tokenPath = join(dir, "token.json");
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

describe("TokenStore", () => {
  test("round-trips a token through the cache file", async () => {
    const saved = token();
    await store().save(saved);
    expect(await store().load()).toEqual(saved);
  });

  test("writes the cache owner-only — it holds a long-lived refresh token", async () => {
    await store().save(token());
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  test("returns null for a missing cache", async () => {
    expect(await store().load()).toBeNull();
  });

  test("treats a corrupt cache as absent rather than crashing", async () => {
    await Bun.write(tokenPath, "{ not json");
    expect(await store().load()).toBeNull();
  });

  test("serves a valid cached token without hitting the network", async () => {
    await store().save(token());
    stubFetch([]);
    expect(await store().accessToken()).toBe("old-access");
  });

  test("refreshes a token inside the expiry margin", async () => {
    // 30s of validity left — inside the 60s refresh margin, so it must refresh.
    await store().save(token({ expiresAt: Date.now() + 30_000 }));
    const calls = stubFetch([
      { status: 200, body: { access_token: "new-access", token_type: "Bearer", expires_in: 3600 } },
    ]);

    expect(await store().accessToken()).toBe("new-access");
    expect(calls[0]?.get("grant_type")).toBe("refresh_token");
    expect(calls[0]?.get("refresh_token")).toBe("refresh-1");
    expect(calls[0]?.get("client_id")).toBe("client-id");
  });

  test("keeps the existing refresh token when the response omits one", async () => {
    await store().save(token({ expiresAt: Date.now() - 1 }));
    stubFetch([
      { status: 200, body: { access_token: "new-access", token_type: "Bearer", expires_in: 3600 } },
    ]);

    const s = store();
    await s.accessToken();
    expect((await s.load())?.refreshToken).toBe("refresh-1");
  });

  test("adopts a rotated refresh token", async () => {
    await store().save(token({ expiresAt: Date.now() - 1 }));
    stubFetch([
      {
        status: 200,
        body: {
          access_token: "new-access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh-2",
        },
      },
    ]);

    const s = store();
    await s.accessToken();
    expect((await s.load())?.refreshToken).toBe("refresh-2");
  });

  test("coalesces concurrent refreshes into one request", async () => {
    await store().save(token({ expiresAt: Date.now() - 1 }));
    const calls = stubFetch([
      { status: 200, body: { access_token: "new-access", token_type: "Bearer", expires_in: 3600 } },
    ]);

    const s = store();
    const results = await Promise.all([s.accessToken(), s.accessToken(), s.accessToken()]);
    expect(results).toEqual(["new-access", "new-access", "new-access"]);
    expect(calls.length).toBe(1);
  });

  test("surfaces invalid_grant as re-auth required", async () => {
    await store().save(token({ expiresAt: Date.now() - 1 }));
    stubFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "Refresh token revoked" } },
    ]);

    expect(store().accessToken()).rejects.toThrow(ReauthRequiredError);
  });

  test("requires re-auth when there is no refresh token", async () => {
    await store().save({ ...token(), refreshToken: undefined, expiresAt: Date.now() - 1 });
    stubFetch([]);
    expect(store().accessToken()).rejects.toThrow(ReauthRequiredError);
  });

  test("requires re-auth when nothing is cached", async () => {
    expect(store().accessToken()).rejects.toThrow(ReauthRequiredError);
  });
});
