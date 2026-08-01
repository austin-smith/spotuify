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

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(
  width: number,
  height: number,
  updateAvailable: boolean,
): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <SetupScreen
      updateAvailable={updateAvailable}
      width={width}
      height={height}
      authCommand="spotuify auth"
    />,
  );
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

describe("setup screen layout", () => {
  test.each(SUPPORTED_SIZES)(
    "shows the setup handoff at %ix%i",
    async (width, height) => {
      const lines = await render(width, height, true);
      const screen = lines.join("\n");

      expect(screen).toContain(width >= 80 ? "███████╗" : "SPOTUIFY");
      expect(screen).toContain("Setup required.");
      expect(screen).toContain("Run spotuify auth to get started.");
      expect(screen).not.toContain("developer.spotify.com");
      expect(screen).not.toContain("SPOTUIFY_CLIENT_ID");
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

      expect(screen).toContain("Setup required.");
      expect(screen).toContain("Run spotuify auth to get started.");
      expect(screen).not.toContain("Update available");
      expect(lines[height - 2]).toContain("Q to quit.");
    },
  );
});
