import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpotifyApiError, SpotifyLimitError } from "../src/api/client.ts";
import type { SpotifyClient } from "../src/api/client.ts";
import {
  bootProfileRecoveryMode,
  loadProfile,
  recoverBootProfile,
  resolveBootProfile,
  retryBootProfile,
  saveProfile,
  shouldRetryBootProfile,
} from "../src/auth/profile.ts";
import { ReauthRequiredError } from "../src/auth/tokens.ts";

const AUTHORIZATION_ID = "authorization-1";

describe("cached account profile", () => {
  test("a finite boot deadline schedules recovery even when a cached profile is usable", () => {
    expect(bootProfileRecoveryMode(Date.now() + 30_000, 0)).toBe("automatic");
    expect(bootProfileRecoveryMode(null, 0)).toBeNull();
    expect(bootProfileRecoveryMode(null, 1)).toBe("manual");
    expect(bootProfileRecoveryMode(Date.now() + 30_000, 1)).toBe("manual");
  });

  test("routes refresh back to a failed account recovery after its cooldown clears", () => {
    const profile = { id: "user", display_name: "User" };

    expect(shouldRetryBootProfile(profile, true, null)).toBeTrue();
    expect(shouldRetryBootProfile(profile, false, null)).toBeFalse();
    expect(
      shouldRetryBootProfile(profile, false, {
        kind: "quota",
        retryAt: null,
        detail: "Too many requests",
      }),
    ).toBeTrue();
    expect(
      shouldRetryBootProfile(profile, false, {
        kind: "rate-limit",
        retryAt: Date.now() + 30_000,
        detail: "Slow down",
      }),
    ).toBeFalse();
    expect(shouldRetryBootProfile(null, false, null)).toBeTrue();
  });

  test("round-trips the minimal boot identity with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "profile.json");
    await saveProfile(
      {
        id: "user",
        display_name: "User",
        product: "premium",
        country: "US",
      },
      AUTHORIZATION_ID,
      path,
    );

    expect(await loadProfile(AUTHORIZATION_ID, path)).toEqual({
      id: "user",
      display_name: "User",
      product: "premium",
      country: "US",
    });
    expect(await Bun.file(path).json()).toEqual({
      authorizationId: AUTHORIZATION_ID,
      profile: {
        id: "user",
        display_name: "User",
        product: "premium",
        country: "US",
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("rejects malformed or incomplete cache data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "profile.json");
    await Bun.write(path, "{\"display_name\":\"missing id\"}");
    await chmod(path, 0o600);
    expect(await loadProfile(AUTHORIZATION_ID, path)).toBeNull();

    await Bun.write(
      path,
      JSON.stringify({ authorizationId: AUTHORIZATION_ID, profile: null }),
    );
    expect(await loadProfile(AUTHORIZATION_ID, path)).toBeNull();
  });

  test("quota exhaustion boots from the last verified profile without another request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "profile.json");
    await saveProfile(
      { id: "user", display_name: "User", product: "premium" },
      AUTHORIZATION_ID,
      path,
    );
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        throw new SpotifyLimitError("/me", "Too many requests", "QUOTA_EXCEEDED", 1234);
      },
    } as unknown as Pick<SpotifyClient, "get">;

    expect(await resolveBootProfile(client, AUTHORIZATION_ID, path)).toEqual({
      profile: {
        id: "user",
        display_name: "User",
        product: "premium",
      },
      retryAt: 1234,
    });
    expect(reads).toBe(1);
  });

  test("quota exhaustion without a profile enters profile-less mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "missing.json");
    const client = {
      get: async () => {
        throw new SpotifyLimitError("/me", "Too many requests", "QUOTA_EXCEEDED", null);
      },
    } as unknown as Pick<SpotifyClient, "get">;

    expect(await resolveBootProfile(client, AUTHORIZATION_ID, path)).toEqual({
      profile: null,
      retryAt: null,
    });
  });

  test("non-quota failures are never hidden by cached profile data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "profile.json");
    await saveProfile({ id: "user", display_name: "User" }, AUTHORIZATION_ID, path);
    const client = {
      get: async () => {
        throw new Error("authentication failed");
      },
    } as unknown as Pick<SpotifyClient, "get">;

    await expect(resolveBootProfile(client, AUTHORIZATION_ID, path)).rejects.toThrow(
      "authentication failed",
    );
  });

  test("a cache write failure cannot discard a profile returned by Spotify", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const nonDirectory = join(dir, "not-a-directory");
    await Bun.write(nonDirectory, "occupied");
    const client = {
      get: async () => ({ id: "user", display_name: "User", country: "US" }),
    } as unknown as Pick<SpotifyClient, "get">;

    expect(
      await resolveBootProfile(
        client,
        AUTHORIZATION_ID,
        join(nonDirectory, "profile.json"),
      ),
    ).toEqual({
      profile: {
        id: "user",
        display_name: "User",
        country: "US",
      },
      retryAt: null,
    });
  });

  test("an inaccessible optional cache behaves like a cache miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const nonDirectory = join(dir, "not-a-directory");
    await Bun.write(nonDirectory, "occupied");

    expect(
      await loadProfile(AUTHORIZATION_ID, join(nonDirectory, "profile.json")),
    ).toBeNull();
  });

  test("never loads a profile from a different authorization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "profile.json");
    await saveProfile({ id: "first-user", display_name: "First" }, "first-authorization", path);

    expect(await loadProfile("second-authorization", path)).toBeNull();
  });

  test("retries profile resolution once at Spotify's finite cooldown deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const path = join(dir, "profile.json");
    let reads = 0;
    const retryAt = Date.now() + 10;
    const client = {
      get: async () => {
        reads++;
        return { id: "user", display_name: "User", country: "US" };
      },
    } as unknown as Pick<SpotifyClient, "get">;

    const profile = await recoverBootProfile(
      client,
      AUTHORIZATION_ID,
      new AbortController().signal,
      retryAt,
      path,
    );

    expect(profile?.id).toBe("user");
    expect(reads).toBe(1);
    expect(await loadProfile(AUTHORIZATION_ID, path)).toEqual(profile);
  });

  test("an already elapsed deadline still performs one profile recovery attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spotuify-profile-"));
    const nonDirectory = join(dir, "not-a-directory");
    await Bun.write(nonDirectory, "occupied");
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        return { id: "user", display_name: "User" };
      },
    } as unknown as Pick<SpotifyClient, "get">;

    expect(
      await recoverBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
        Date.now() - 1,
        join(nonDirectory, "profile.json"),
      ),
    ).toEqual({ id: "user", display_name: "User" });
    expect(reads).toBe(1);
  });

  test("a recovery 429 replaces the consumed deadline without polling", async () => {
    let reads = 0;
    const nextRetryAt = Date.now() + 10;
    const client = {
      get: async () => {
        reads++;
        if (reads === 1) {
          throw new SpotifyLimitError(
            "/me",
            "Too many requests",
            "QUOTA_EXCEEDED",
            nextRetryAt,
          );
        }
        return { id: "user", display_name: "User" };
      },
    } as unknown as Pick<SpotifyClient, "get">;

    expect(
      await recoverBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
        Date.now() - 1,
      ),
    ).toEqual({ id: "user", display_name: "User" });
    expect(reads).toBe(2);
  });

  test("a repeated immediately retryable 429 stops instead of spinning", async () => {
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        throw new SpotifyLimitError(
          "/me",
          "Too many requests",
          "QUOTA_EXCEEDED",
          Date.now(),
        );
      },
    } as unknown as Pick<SpotifyClient, "get">;

    await expect(
      recoverBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
        Date.now() - 1,
      ),
    ).rejects.toMatchObject({
      status: 429,
      retryAt: expect.any(Number),
    });
    expect(reads).toBe(1);
  });

  test("transient recovery failures use a bounded retry budget", async () => {
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        if (reads < 3) throw new TypeError("network unavailable");
        return { id: "user", display_name: "User" };
      },
    } as unknown as Pick<SpotifyClient, "get">;

    expect(
      await recoverBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
        Date.now() - 1,
        undefined,
        [0, 0],
      ),
    ).toEqual({ id: "user", display_name: "User" });
    expect(reads).toBe(3);
  });

  test("exhausted transient recovery stops instead of becoming a polling loop", async () => {
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        throw new SpotifyApiError(503, "/me", "temporarily unavailable");
      },
    } as unknown as Pick<SpotifyClient, "get">;

    await expect(
      recoverBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
        Date.now() - 1,
        undefined,
        [0, 0],
      ),
    ).rejects.toThrow("temporarily unavailable");
    expect(reads).toBe(3);
  });

  test("authentication failures never consume the transient retry budget", async () => {
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        throw new ReauthRequiredError("refresh token revoked.");
      },
    } as unknown as Pick<SpotifyClient, "get">;

    await expect(
      recoverBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
        Date.now() - 1,
        undefined,
        [0, 0, 0],
      ),
    ).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(reads).toBe(1);
  });

  test("does not retry when Spotify supplied no cooldown deadline", async () => {
    let reads = 0;
    const client = {
      get: async () => {
        reads++;
        return { id: "user", display_name: "User" };
      },
    } as unknown as Pick<SpotifyClient, "get">;

    expect(
      await recoverBootProfile(client, AUTHORIZATION_ID, new AbortController().signal, null),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test("manual recovery performs exactly one explicit indefinite-cooldown probe", async () => {
    let normalReads = 0;
    let probes = 0;
    const client = {
      get: async () => {
        normalReads++;
        throw new Error("ordinary reads must remain gated");
      },
      retryAfterIndefiniteCooldown: async () => {
        probes++;
        return { id: "user", display_name: "User" };
      },
    } as unknown as Pick<
      SpotifyClient,
      "get" | "retryAfterIndefiniteCooldown"
    >;

    expect(
      await retryBootProfile(
        client,
        AUTHORIZATION_ID,
        new AbortController().signal,
      ),
    ).toEqual({ id: "user", display_name: "User" });
    expect(probes).toBe(1);
    expect(normalReads).toBe(0);
  });
});
