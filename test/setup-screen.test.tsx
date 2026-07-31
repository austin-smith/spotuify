import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { SetupScreen } from "../src/ui/SetupScreen.tsx";

const SUPPORTED_SIZES = [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 40],
] as const;

const LONG_ERROR =
  "Spotify rejected the cached authorization after account verification returned an unexpected response. Run spotuify auth to sign in again. ".repeat(
    12,
  );

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(width: number, height: number, updateAvailable: boolean): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <SetupScreen
      message={LONG_ERROR}
      updateAvailable={updateAvailable}
      width={width}
      height={height}
    />,
  );
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

describe("setup screen layout", () => {
  test.each(SUPPORTED_SIZES)(
    "keeps setup actions visible with a long error at %ix%i",
    async (width, height) => {
      const lines = await render(width, height, true);
      const screen = lines.join("\n");

      expect(screen).toContain("SPOTUIFY");
      expect(screen).toContain("Redirect URI to register:");
      expect(screen).toContain("Then run:");
      expect(screen).toContain("Update available — run: spotuify update");
      expect(screen).toContain("Q to quit.");
      expect(lines[height - 2]).toContain("Q to quit.");

      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  test.each(SUPPORTED_SIZES)(
    "keeps quit visible without an update at %ix%i",
    async (width, height) => {
      const lines = await render(width, height, false);
      const screen = lines.join("\n");

      expect(screen).not.toContain("Update available");
      expect(lines[height - 2]).toContain("Q to quit.");
    },
  );
});
