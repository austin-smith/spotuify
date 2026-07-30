import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PlayerCommandRejectedError, PremiumRequiredError, SpotifyApiError } from "../src/api/client.ts";
import type { PlayerApi } from "../src/api/player.ts";
import type { PlaybackState } from "../src/api/types.ts";
import { ReauthRequiredError } from "../src/auth/tokens.ts";
import {
  COMMAND_RECONCILE_MS,
  ERROR_LINGER_MS,
  usePlayback,
} from "../src/store/playback.ts";

const STATE: PlaybackState = {
  item: {
    id: "t",
    name: "Track",
    uri: "spotify:track:t",
    duration_ms: 200_000,
    artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
    album: { id: "al", name: "Album", uri: "spotify:album:al", images: [] },
  },
  is_playing: true,
  progress_ms: 1_000,
  shuffle_state: false,
  repeat_state: "off",
  context: null,
  currently_playing_type: "track",
  device: { id: "d", name: "spotuify", type: "Computer", is_active: true, is_restricted: false, volume_percent: 50 },
};

/** A player whose commands fail in a chosen way; `state()` always succeeds. */
function player(failure: unknown, onState?: () => void): PlayerApi {
  const reject = async () => {
    throw failure;
  };
  return {
    state: async () => {
      onState?.();
      return STATE;
    },
    next: reject,
    previous: reject,
    pause: reject,
    play: reject,
    seek: reject,
    setVolume: reject,
    setShuffle: reject,
    setRepeat: reject,
  } as unknown as PlayerApi;
}

let stop: (() => void) | undefined;

beforeEach(() => {
  usePlayback.setState({ error: null, ready: false, item: null, volumePercent: 50 });
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

async function withFailure(failure: unknown, onState?: () => void) {
  stop = usePlayback.getState().start(player(failure, onState));
  // Let the first poll land so the store is populated before the command runs.
  await Bun.sleep(20);
}

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  expect(predicate()).toBe(true);
}

describe("declined commands", () => {
  // Spotify answers 403 "Restriction violated" when there is nothing to go back to. That is an
  // outcome, not a fault, and its own clients show nothing.
  test("a rejected command reports nothing", async () => {
    await withFailure(new PlayerCommandRejectedError("Restriction violated"));
    await usePlayback.getState().previous();
    expect(usePlayback.getState().error).toBeNull();
  });

  test("a rejected next command reports nothing", async () => {
    await withFailure(new PlayerCommandRejectedError("Restriction violated"));
    await usePlayback.getState().next();
    expect(usePlayback.getState().error).toBeNull();
  });

  test("a real failure still reports", async () => {
    await withFailure(new SpotifyApiError(404, "/me/player/next", "Device not found"));
    await usePlayback.getState().next();
    expect(usePlayback.getState().error).not.toBeNull();
  });
});

describe("messages", () => {
  const messageFor = async (failure: unknown) => {
    await withFailure(failure);
    await usePlayback.getState().next();
    return usePlayback.getState().error ?? "";
  };

  test("404 says what to do about it", async () => {
    expect(await messageFor(new SpotifyApiError(404, "/me/player/next", "Device not found"))).toBe(
      "no active device — press d to pick one",
    );
  });

  test("an expired session points at the fix", async () => {
    expect(await messageFor(new ReauthRequiredError("bad refresh token"))).toContain("spotuify auth");
  });

  test("premium is stated plainly", async () => {
    expect(await messageFor(new PremiumRequiredError())).toContain("premium");
  });

  test("no message names an endpoint", async () => {
    const message = await messageFor(new SpotifyApiError(500, "/me/player/next", "Server error"));
    expect(message).not.toContain("/me/player");
    expect(message).not.toContain("Spotify API");
  });
});

describe("how long an error stays up", () => {
  // Commands refresh ~300ms after failing. Clearing the error on that refresh made every failure a
  // flash the user had no chance to read.
  test("the command's own refresh does not clear it", async () => {
    await withFailure(new SpotifyApiError(404, "/me/player/next", "Device not found"));
    await usePlayback.getState().next(); // sleeps 300ms, then refreshes successfully
    expect(usePlayback.getState().error).not.toBeNull();
  });

  test("next starts a fresh linger window", async () => {
    const realNow = performance.now;
    let now = 100;
    performance.now = () => now;

    try {
      await withFailure(new SpotifyApiError(404, "/me/player/next", "Device not found"));

      // Seed an old error timestamp through a command that already uses the shared handler.
      await usePlayback.getState().previous();
      usePlayback.setState({ error: null });
      now += ERROR_LINGER_MS + 1;

      await usePlayback.getState().next();
      expect(usePlayback.getState().error).not.toBeNull();
    } finally {
      performance.now = realNow;
    }
  });

  // The successful command reconciliation proves the app recovered, but the message remains
  // readable for the full linger window and then clears without spending another API request.
  test("successful reconciliation schedules clearing without another read", async () => {
    let reads = 0;
    await withFailure(
      new SpotifyApiError(404, "/me/player/next", "Device not found"),
      () => reads++,
    );
    await usePlayback.getState().next();

    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const realNow = performance.now;
    let placeholder: ReturnType<typeof setTimeout> | undefined;
    let runScheduledClear: (() => void) | undefined;
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (
        runScheduledClear === undefined &&
        delay !== undefined &&
        delay > COMMAND_RECONCILE_MS &&
        delay <= ERROR_LINGER_MS
      ) {
        placeholder = realSetTimeout(() => {}, ERROR_LINGER_MS);
        runScheduledClear = () => {
          if (placeholder !== undefined) realClearTimeout(placeholder);
          callback(...args);
        };
        return placeholder;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;

    try {
      const reconciliationDeadline = realNow() + COMMAND_RECONCILE_MS + 1;
      performance.now = () => reconciliationDeadline;
      await usePlayback.getState().refresh();

      expect(reads).toBe(2);
      expect(runScheduledClear).toBeFunction();
      expect(usePlayback.getState().error).not.toBeNull();

      runScheduledClear?.();

      expect(usePlayback.getState().error).toBeNull();
      expect(reads).toBe(2);
    } finally {
      performance.now = realNow;
      globalThis.setTimeout = realSetTimeout;
      if (placeholder !== undefined) realClearTimeout(placeholder);
    }
  });
});
