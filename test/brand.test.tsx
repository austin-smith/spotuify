import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  playbackEmptyStateText,
  STARTUP_MESSAGE,
} from "../src/ui/PlaybackEmptyState.tsx";
import {
  BrandLockup,
  BrandSplash,
  brandLockupHeight,
  brandLockupMode,
  brandSplashLayout,
} from "../src/ui/Brand.tsx";
import { TAGLINE } from "../src/branding.ts";

/** Leading cells of the `tiny` wordmark art, which spells nothing a substring search can find. */
const WORDMARK_ART = "█▀▀ █▀█ █▀█";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

describe("responsive brand lockup", () => {
  test("selects a lockup from measured width and height", () => {
    expect(brandLockupMode(29, 2)).toBe("art");
    expect(brandLockupHeight(29, 2)).toBe(2);
    expect(brandLockupMode(28, 2)).toBe("plain");
    expect(brandLockupMode(100, 1)).toBe("plain");
  });

  test("measures wrapped guidance before choosing the brand treatment", () => {
    const message = playbackEmptyStateText(true, true, true);
    expect(brandSplashLayout(message, 24, 5)).toEqual({
      innerWidth: 20,
      messageLines: ["NOTHING PLAYING —", "press / to find", "something"],
      brandHeight: 1,
      taglineHeight: 0,
      taglineGapHeight: 0,
      gapHeight: 1,
      totalHeight: 5,
      top: 0,
    });
    expect(brandSplashLayout(message, 24, 3)).toMatchObject({
      brandHeight: 0,
      gapHeight: 0,
      totalHeight: 3,
      top: 0,
    });
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
      expect(screen).toContain(WORDMARK_ART);
      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  test.each([[24], [40], [80], [120]] as const)(
    "anchors the wordmark on one row across every startup message at width %i",
    (width) => {
      const height = 19;
      const layouts = [
        "",
        STARTUP_MESSAGE,
        playbackEmptyStateText(true, true, true),
        playbackEmptyStateText(true, false, true),
      ].map((message) => brandSplashLayout(message, width, height));

      const tops = new Set(layouts.map((layout) => layout.top));
      const brandHeights = new Set(layouts.map((layout) => layout.brandHeight));
      expect(tops.size).toBe(1);
      expect(brandHeights.size).toBe(1);
    },
  );

  test("keeps the wordmark stationary as startup messages come and go", async () => {
    const width = 24;
    const height = 19;
    setup = await createTestRenderer({ width, height });
    const root = createRoot(setup.renderer);

    const wordmarkRow = async (message: string) => {
      root.render(
        <box width={width} height={height} position="relative">
          <BrandSplash message={message} width={width} height={height} />
        </box>,
      );
      await Bun.sleep(20);
      await setup!.renderOnce();
      return setup!
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("SPOTUIFY"));
    };

    const blankRow = await wordmarkRow("");
    expect(blankRow).toBeGreaterThan(0);
    expect(await wordmarkRow(STARTUP_MESSAGE)).toBe(blankRow);
    expect(await wordmarkRow(playbackEmptyStateText(true, true, true))).toBe(blankRow);
  });

  test("yields the tagline row rather than moving the wordmark or clipping the message", () => {
    const message = playbackEmptyStateText(true, true, true);
    const rows = (height: number) => brandSplashLayout(message, 60, height);

    // Heights where the tagline and its gap would shift the wordmark or overflow the region.
    for (let height = 3; height <= 8; height++) {
      const layout = rows(height);
      expect(layout.brandHeight).toBeGreaterThan(0);
      expect(layout.taglineHeight).toBe(0);
      expect(layout.totalHeight).toBeLessThanOrEqual(height);
    }

    // The first height with both rows genuinely to spare takes them.
    const taken = rows(9);
    expect(taken.taglineHeight).toBe(1);
    expect(taken.totalHeight).toBeLessThanOrEqual(9);
    expect(taken.top).toBe(rows(8).top);
  });

  test("never lets the tagline drift the wordmark between messages", () => {
    const width = 60;
    const height = 19;
    const layouts = [
      "",
      STARTUP_MESSAGE,
      playbackEmptyStateText(true, true, true),
      playbackEmptyStateText(true, false, true),
    ].map((message) => brandSplashLayout(message, width, height));

    expect(new Set(layouts.map((layout) => layout.top)).size).toBe(1);
    expect(new Set(layouts.map((layout) => layout.brandHeight)).size).toBe(1);
    expect(layouts.every((layout) => layout.taglineHeight === 1)).toBe(true);
  });

  test("renders the tagline between the wordmark and the message", async () => {
    const width = 60;
    const height = 20;
    setup = await createTestRenderer({ width, height });
    createRoot(setup.renderer).render(
      <box width={width} height={height} position="relative">
        <BrandSplash message="Connecting to Spotify…" width={width} height={height} />
      </box>,
    );
    await Bun.sleep(20);
    await setup.renderOnce();

    const layout = brandSplashLayout("Connecting to Spotify…", width, height);
    const lines = setup.captureCharFrame().split("\n");
    const wordmarkRow = lines.findIndex((line) => line.includes(WORDMARK_ART));
    const taglineRow = lines.findIndex((line) => line.includes(TAGLINE));
    const messageRow = lines.findIndex((line) => line.includes("Connecting to Spotify…"));

    // A blank row separates the tagline from the wordmark art, and another from the message.
    expect(layout.taglineHeight).toBe(1);
    expect(wordmarkRow).toBeGreaterThanOrEqual(0);
    expect(taglineRow).toBe(wordmarkRow + layout.brandHeight + 1);
    expect(messageRow).toBe(taglineRow + 2);
    for (const line of lines.slice(0, height)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("falls back to readable plain text in a tiny region", async () => {
    setup = await createTestRenderer({ width: 24, height: 5 });
    createRoot(setup.renderer).render(<BrandLockup width={24} maxHeight={1} />);
    await Bun.sleep(20);
    await setup.renderOnce();

    expect(setup.captureCharFrame()).toContain("SPOTUIFY");
  });

  test("keeps wrapped empty-state guidance visible in a narrow splash", async () => {
    const width = 24;
    const height = 5;
    const message = playbackEmptyStateText(true, true, true);
    setup = await createTestRenderer({ width, height });
    createRoot(setup.renderer).render(
      <box width={width} height={height} position="relative">
        <BrandSplash message={message} width={width} height={height} />
      </box>,
    );
    await Bun.sleep(20);
    await setup.renderOnce();

    const lines = setup.captureCharFrame().split("\n");
    const visibleText = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ");
    expect(visibleText).toContain(`SPOTUIFY ${message}`);
    for (const line of lines.slice(0, height)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
