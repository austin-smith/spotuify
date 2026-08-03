import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyApiError } from "../src/api/client.ts";
import { ReauthRequiredError } from "../src/auth/tokens.ts";
import { MissingClientIdError } from "../src/config.ts";
import { bootFailureFor } from "../src/ui/App.tsx";
import {
  startupErrorLayout,
  StartupErrorScreen,
} from "../src/ui/StartupErrorScreen.tsx";

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
  test("measures wrapped heading and recovery hints before allocating branding", () => {
    const layout = startupErrorLayout("failure", 14, 7);

    expect(layout.headingLines).toEqual(["Startup", "failed."]);
    expect(layout.footerLines).toEqual(["r to", "retry.", "q to quit."]);
    expect(layout.brandHeight).toBe(0);
    expect(layout.brandGapHeight).toBe(0);
    expect(layout.messageLines).toEqual([]);
    expect(layout.messageGapHeight).toBe(0);
    expect(layout.footerGapHeight).toBe(0);
  });

  test("keeps recovery actions visible when error chrome wraps", async () => {
    setup = await createTestRenderer({ width: 14, height: 7 });
    createRoot(setup.renderer).render(
      <StartupErrorScreen message="failure" width={14} height={7} />,
    );
    await Bun.sleep(20);
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const screen = lines.join("\n");
    const copy = screen.replace(/\s+/g, " ").trim();

    expect(screen).not.toContain("SPOTUIFY");
    expect(copy).toBe("Startup failed. r to retry. q to quit.");
    expect(lines[5]).toContain("q to quit.");

    for (const line of lines.slice(0, 7)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(14);
    }
  });

  test("measures wrapped diagnostics before choosing the brand treatment", () => {
    const message = `${"Detailed diagnostic context ".repeat(16)}END-OF-DIAGNOSTIC`;
    const layout = startupErrorLayout(message, 80, 18);

    expect(layout.messageLines).toHaveLength(7);
    expect(layout.messageLines.at(-1)).toBe("END-OF-DIAGNOSTIC");
    expect(layout.brandHeight).toBe(1);
  });

  test("keeps a seven-row diagnostic intact at 80x18", async () => {
    const message = `${"Detailed diagnostic context ".repeat(16)}END-OF-DIAGNOSTIC`;
    setup = await createTestRenderer({ width: 80, height: 18 });
    createRoot(setup.renderer).render(
      <StartupErrorScreen message={message} width={80} height={18} />,
    );
    await Bun.sleep(20);
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const screen = lines.join("\n");
    expect(screen).toContain("SPOTUIFY");
    expect(screen).not.toContain("███████╗");
    expect(screen).toContain("END-OF-DIAGNOSTIC");
    expect(lines[15]).toContain("r to retry.");
    expect(lines[16]).toContain("q to quit.");
  });

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
      expect(screen).toContain("Startup failed.");
      expect(screen).toContain("Spotify API 503 on /me:");
      expect(screen).not.toContain("spotuify auth");
      expect(lines[height - 3]).toContain("r to retry.");
      expect(lines[height - 2]).toContain("q to quit.");

      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );
});
