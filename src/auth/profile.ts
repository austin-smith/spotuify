import {
  SpotifyApiError,
  SpotifyLimitError,
  type SpotifyClient,
  type SpotifyCooldown,
} from "../api/client.ts";
import type { Me } from "../api/types.ts";
import { PROFILE_PATH } from "../config.ts";
import { writePrivateFileAtomic } from "./private-file.ts";
import { ReauthRequiredError } from "./tokens.ts";

interface CachedProfile {
  authorizationId: string;
  profile: Me;
}

export interface BootProfileResolution {
  profile: Me | null;
  /** The exact finite deadline from the 429 that forced a profile-less boot. */
  retryAt: number | null;
}

/**
 * Decide whether the refresh key belongs to account recovery instead of playback refresh.
 *
 * A missing cooldown is normally healthy and must not turn every refresh into a `/me` request.
 * The explicit failure flag preserves the recovery route after a probe clears its cooldown but
 * later exhausts the bounded transient retry budget.
 */
export function shouldRetryBootProfile(
  profile: Me | null,
  previousRecoveryFailed: boolean,
  cooldown: SpotifyCooldown | null,
): boolean {
  return profile === null || previousRecoveryFailed || cooldown?.retryAt === null;
}

function minimalProfile(profile: Me): Me {
  return {
    id: profile.id,
    display_name: profile.display_name,
    ...(typeof profile.product === "string" ? { product: profile.product } : {}),
    ...(typeof profile.country === "string" ? { country: profile.country } : {}),
  };
}

/** Cache the minimal account identity needed to boot while the Web API is quota-blocked. */
export async function saveProfile(
  profile: Me,
  authorizationId: string,
  path = PROFILE_PATH,
): Promise<void> {
  await writePrivateFileAtomic(
    path,
    `${JSON.stringify({ authorizationId, profile: minimalProfile(profile) }, null, 2)}\n`,
  );
}

export async function loadProfile(
  authorizationId: string,
  path = PROFILE_PATH,
): Promise<Me | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const cached = (await file.json()) as Partial<CachedProfile>;
    if (cached.authorizationId !== authorizationId) return null;
    if (typeof cached.profile !== "object" || cached.profile === null) return null;
    const value = cached.profile as Partial<Me>;
    if (typeof value.id !== "string") return null;
    return {
      id: value.id,
      display_name: typeof value.display_name === "string" ? value.display_name : null,
      ...(typeof value.product === "string" ? { product: value.product } : {}),
      ...(typeof value.country === "string" ? { country: value.country } : {}),
    };
  } catch {
    return null;
  }
}

export async function saveProfileBestEffort(
  profile: Me,
  authorizationId: string,
  path = PROFILE_PATH,
): Promise<void> {
  try {
    await saveProfile(profile, authorizationId, path);
  } catch {
    // This cache only preserves local playback during a later Spotify quota lockout. A filesystem
    // failure must not invalidate an identity that Spotify just returned successfully.
  }
}

/**
 * Resolve the account identity without turning a quota lockout into a setup failure.
 *
 * Only a real Spotify 429 may use the cache. Authentication, scope and transport failures still
 * surface normally, so stale local data cannot hide a broken login.
 */
export async function resolveBootProfile(
  client: Pick<SpotifyClient, "get">,
  authorizationId: string,
  path = PROFILE_PATH,
): Promise<BootProfileResolution> {
  let profile: Me;
  try {
    profile = await client.get<Me>("/me");
  } catch (error) {
    if (!(error instanceof SpotifyLimitError)) throw error;
    return {
      profile: await loadProfile(authorizationId, path),
      retryAt: error.retryAt,
    };
  }
  await saveProfileBestEffort(profile, authorizationId, path);
  return { profile, retryAt: null };
}

type ProfileRecoveryClient = Pick<SpotifyClient, "get"> &
  Partial<Pick<SpotifyClient, "retryAfterIndefiniteCooldown">>;
const PROFILE_RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

function isRetryableProfileFailure(error: unknown): boolean {
  if (error instanceof ReauthRequiredError) return false;
  if (error instanceof SpotifyApiError) return error.status >= 500;
  // Token refresh transport failures and fetch/network errors are not Spotify API responses.
  // They receive the same small bounded retry budget; authentication failures remain explicitly
  // typed as ReauthRequiredError and are handled by the caller.
  return true;
}

function waitUntil(timestamp: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (completed: boolean) => {
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    const schedule = () => {
      const remaining = timestamp - Date.now();
      if (remaining <= 0) {
        finish(true);
        return;
      }
      // JavaScript timers clamp larger delays. Scheduling in bounded chunks prevents a distant
      // server deadline from accidentally turning into a tight retry loop.
      timer = setTimeout(schedule, Math.min(remaining, 2_147_000_000));
    };
    const abort = () => {
      clearTimeout(timer);
      finish(false);
    };
    signal.addEventListener("abort", abort, { once: true });
    schedule();
  });
}

/**
 * Recover a profile-less boot only at Spotify's advertised retry deadline.
 *
 * Each 429 supplies the deadline for at most one subsequent attempt. Unknown deadlines remain
 * fail-closed. Network and 5xx failures get three delayed attempts, after which the UI exposes an
 * explicit manual retry; neither path can become a background polling loop.
 */
async function recoverProfile(
  client: ProfileRecoveryClient,
  authorizationId: string,
  signal: AbortSignal,
  initialRetryAt: number | null,
  path = PROFILE_PATH,
  transientRetryDelaysMs: readonly number[] = PROFILE_RECOVERY_RETRY_DELAYS_MS,
  manual = false,
): Promise<Me | null> {
  let retryAt = initialRetryAt;
  let transientAttempt = 0;
  let firstAttempt = true;
  while (!signal.aborted) {
    if (retryAt === null && !(manual && firstAttempt)) return null;
    if (retryAt !== null && !(await waitUntil(retryAt, signal))) return null;
    firstAttempt = false;

    try {
      if (manual && client.retryAfterIndefiniteCooldown === undefined) {
        throw new Error("Manual profile recovery requires a cooldown probe.");
      }
      const profile =
        manual && client.retryAfterIndefiniteCooldown !== undefined
          ? await client.retryAfterIndefiniteCooldown<Me>("/me")
          : await client.get<Me>("/me");
      await saveProfileBestEffort(profile, authorizationId, path);
      return profile;
    } catch (error) {
      if (signal.aborted) return null;
      if (error instanceof SpotifyLimitError) {
        transientAttempt = 0;
        // A zero or already elapsed replacement would make the loop immediately hit `/me` again.
        // Surface the typed failure instead of converting Spotify's repeated 429s into either a
        // client-side retry storm or an ambiguous successful `null` result.
        if (error.retryAt === null || error.retryAt <= Date.now()) throw error;
        retryAt = error.retryAt;
        continue;
      }
      if (!isRetryableProfileFailure(error)) throw error;
      const delay = transientRetryDelaysMs[transientAttempt++];
      if (delay === undefined) throw error;
      retryAt = Date.now() + Math.max(0, delay);
    }
  }
  return null;
}

export async function recoverBootProfile(
  client: ProfileRecoveryClient,
  authorizationId: string,
  signal: AbortSignal,
  initialRetryAt: number | null,
  path = PROFILE_PATH,
  transientRetryDelaysMs: readonly number[] = PROFILE_RECOVERY_RETRY_DELAYS_MS,
): Promise<Me | null> {
  return await recoverProfile(
    client,
    authorizationId,
    signal,
    initialRetryAt,
    path,
    transientRetryDelaysMs,
  );
}

/** Perform one explicit recovery probe, then retain the same bounded transient retry policy. */
export async function retryBootProfile(
  client: ProfileRecoveryClient,
  authorizationId: string,
  signal: AbortSignal,
  path = PROFILE_PATH,
  transientRetryDelaysMs: readonly number[] = PROFILE_RECOVERY_RETRY_DELAYS_MS,
): Promise<Me | null> {
  return await recoverProfile(
    client,
    authorizationId,
    signal,
    null,
    path,
    transientRetryDelaysMs,
    true,
  );
}
