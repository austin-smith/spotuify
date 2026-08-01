import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BrandLockup,
  BrandSplash,
  brandLockupHeight,
  brandLockupMode,
} from "../src/ui/Brand.tsx";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

describe("responsive brand lockup", () => {
  test("selects a lockup from measured width and height", () => {
    expect(brandLockupMode(70, 6)).toBe("block");
    expect(brandLockupHeight(70, 6)).toBe(6);
    expect(brandLockupMode(69, 6)).toBe("plain");
    expect(brandLockupMode(100, 1)).toBe("plain");
  });

  test.each([
    [60, 20],
    [80, 24],
    [100, 32],
    [120, 40],
  ] as const)(
    "renders the wordmark and message at %ix%i",
    async (width, height) => {
      setup = await createTestRenderer({ width, height });
      createRoot(setup.renderer).render(
        <box width={width} height={height} position="relative">
          <BrandSplash message="Connecting to Spotify…" width={width} height={height} />
        </box>,
      );
      await Bun.sleep(20);
      await setup.renderOnce();

      const lines = setup.captureCharFrame().split("\n");
      const screen = lines.join("\n");
      expect(screen).toContain("Connecting to Spotify…");
      expect(screen).toContain(width >= 80 ? "███████╗" : "SPOTUIFY");
      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  test("falls back to readable plain text in a tiny region", async () => {
    setup = await createTestRenderer({ width: 24, height: 5 });
    createRoot(setup.renderer).render(<BrandLockup width={24} maxHeight={1} />);
    await Bun.sleep(20);
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("SPOTUIFY");
  });
});
