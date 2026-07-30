import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { Track } from "../src/api/types.ts";
import {
  FeedbackBanner,
  feedbackTopAboveHud,
} from "../src/ui/FeedbackBanner.tsx";
import { Hud, HUD_LEFT, HUD_ROWS, hudTopForHeight } from "../src/ui/Hud.tsx";
import { KEY_HINT_ROWS } from "../src/ui/KeyHints.tsx";

const TRACK: Track = {
  id: "special-power",
  name: "Special Power",
  uri: "spotify:track:special-power",
  duration_ms: 180_000,
  artists: [{ id: "sadurn", name: "Sadurn", uri: "spotify:artist:sadurn" }],
  album: {
    id: "album",
    name: "Album",
    uri: "spotify:album:album",
    images: [],
  },
};

const MESSAGE = "saved special power to liked songs";
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [100, 32],
  [80, 24],
  [60, 20],
];

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function capture(
  component: React.ReactNode,
  width: number,
  height: number,
): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(component);
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

describe("feedback banner", () => {
  test.each(SIZES)(
    "opaque backing prevents lower-layer glyphs showing through spaces at %ix%i",
    async (width, height) => {
      const top = 2;
      const lines = await capture(
        <box flexGrow={1} position="relative">
          <box position="absolute" left={HUD_LEFT} top={top} zIndex={1}>
            <text>savedAspecial power to liked songs</text>
          </box>
          <FeedbackBanner
            message={MESSAGE}
            kind="success"
            width={width}
            top={top}
            textLeft={HUD_LEFT}
          />
        </box>,
        width,
        height,
      );

      expect(lines[top]?.indexOf(MESSAGE)).toBe(HUD_LEFT);
      expect(lines[top]).not.toContain("savedAspecial");
    },
  );

  test.each(SIZES)("sits above, rather than on, the first HUD row at %ix%i", async (width, height) => {
    const contentHeight = height - KEY_HINT_ROWS;
    const hudTop = hudTopForHeight(contentHeight);
    const feedbackTop = feedbackTopAboveHud(hudTop);
    const lines = await capture(
      <box flexGrow={1} position="relative">
        <Hud
          item={TRACK}
          progressMs={60_000}
          durationMs={TRACK.duration_ms}
          isPlaying
          shuffle={false}
          repeat="off"
          volumePercent={100}
          deviceName={null}
          isLocalDevice
          width={width}
          height={contentHeight}
        />
        <FeedbackBanner
          message={MESSAGE}
          kind="success"
          width={width}
          top={feedbackTop}
          textLeft={HUD_LEFT}
        />
      </box>,
      width,
      height,
    );

    expect(hudTop).toBe(height - KEY_HINT_ROWS - HUD_ROWS);
    expect(feedbackTop).toBe(hudTop - 2);
    expect(lines[feedbackTop]?.indexOf(MESSAGE)).toBe(HUD_LEFT);
    expect(lines[feedbackTop + 1]?.trim()).toBe("");
    expect(lines[hudTop]).toContain("SPECIAL POWER");
    expect(lines[hudTop]).not.toContain("saved");
  });
});
