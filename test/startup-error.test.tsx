import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyApiError } from "../src/api/client.ts";
import { ReauthRequiredError } from "../src/auth/tokens.ts";
import { MissingClientIdError } from "../src/config.ts";
import { bootFailureFor } from "../src/ui/App.tsx";
import { StartupErrorScreen } from "../src/ui/StartupErrorScreen.tsx";

const SUPPORTED_SIZES = [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 40],
] as const;

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

describe("startup failure classification", () => {
  test("routes missing setup and expired authorization to setup", () => {
    expect(bootFailureFor(new MissingClientIdError())).toEqual({ phase: "needs-setup" });
    expect(bootFailureFor(new ReauthRequiredError("Refresh token expired."))).toEqual({
      phase: "needs-setup",
    });
    expect(bootFailureFor(new SpotifyApiError(401, "/me", "Unauthorized"))).toEqual({
      phase: "needs-setup",
    });
  });

  test("preserves transport and Spotify server failures", () => {
    expect(bootFailureFor(new Error("Network connection failed."))).toEqual({
      phase: "failed",
      message: "Network connection failed.",
    });
    expect(
      bootFailureFor(new SpotifyApiError(503, "/me", "Service unavailable")),
    ).toEqual({
      phase: "failed",
      message: "Spotify API 503 on /me: Service unavailable",
    });
  });
});

describe("startup error screen layout", () => {
  test.each(SUPPORTED_SIZES)(
    "keeps recovery actions visible at %ix%i",
    async (width, height) => {
      setup = await createTestRenderer({ width, height });
      createRoot(setup.renderer).render(
        <StartupErrorScreen
          message={`Spotify API 503 on /me: ${"Service unavailable. ".repeat(100)}`}
          width={width}
          height={height}
        />,
      );
      await Bun.sleep(20);
      await setup.renderOnce();

      const lines = setup.captureCharFrame().split("\n");
      const screen = lines.join("\n");
      expect(screen).toContain(width >= 80 ? "███████╗" : "SPOTUIFY");
      expect(screen).toContain("Startup failed.");
      expect(screen).toContain("Spotify API 503 on /me:");
      expect(screen).not.toContain("spotuify auth");
      expect(lines[height - 3]).toContain("R to retry.");
      expect(lines[height - 2]).toContain("Q to quit.");

      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );
});
