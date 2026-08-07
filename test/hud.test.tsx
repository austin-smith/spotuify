import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { Track } from "../src/api/types.ts";
import { Hud, HUD_ROWS } from "../src/ui/Hud.tsx";
import { KeyHints, KEY_HINT_ROWS } from "../src/ui/KeyHints.tsx";
import { barFor } from "../src/ui/keys.ts";

const TRACK: Track = {
  id: "t1",
  name: "Miss You - Bonus Track",
  uri: "spotify:track:t1",
  duration_ms: 206_000,
  artists: [
    { id: "a1", name: "Oliver Tree", uri: "spotify:artist:a1" },
    { id: "a2", name: "Robin Schulz", uri: "spotify:artist:a2" },
  ],
  album: { id: "al1", name: "Alone In A Crowd", uri: "spotify:album:al1", images: [] },
};

/** The overlays only. The backdrop needs FFI and a network fetch; its geometry is covered by unit tests. */
function Overlays({
  width,
  height,
  item = TRACK,
  deviceName = "spotuify",
  isLocalDevice = true,
}: {
  width: number;
  height: number;
  item?: Track;
  deviceName?: string;
  isLocalDevice?: boolean;
}) {
  return (
    <box flexGrow={1} position="relative">
      <Hud
        item={item}
        progressMs={95_000}
        durationMs={206_000}
        isPlaying
        shuffle={false}
        repeat="off"
      volumePercent={100}
      deviceName={deviceName}
      isLocalDevice={isLocalDevice}
        width={width}
        height={height - KEY_HINT_ROWS}
      />
      <box
        position="absolute"
        left={0}
        top={height - KEY_HINT_ROWS}
        width={width}
        zIndex={2}
      >
        <KeyHints width={width} playing hasTrack />
      </box>
    </box>
  );
}

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(
  width: number,
  height: number,
  item?: Track,
  deviceName?: string,
  isLocalDevice?: boolean,
): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <Overlays
      width={width}
      height={height}
      item={item}
      deviceName={deviceName}
      isLocalDevice={isLocalDevice}
    />,
  );
  // The React reconciler commits asynchronously; without this the frame is blank.
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [120, 40],
  [100, 32],
  [90, 50],
  [80, 24],
  [60, 20],
];

test("profile-less quota mode does not advertise account-bound actions", () => {
  const hints = barFor({ playing: true, hasTrack: true, canBrowse: false });
  expect(hints).not.toContainEqual({ key: "/", action: "search" });
  expect(hints).not.toContainEqual({ key: "b", action: "library" });
  expect(hints).not.toContainEqual({ key: "a", action: "go to" });
  expect(hints).not.toContainEqual({ key: "d", action: "device" });
  expect(hints).toContainEqual({ key: "r", action: "retry account" });
});

describe("hud", () => {
  test.each(SIZES)("identity sits on the first HUD row at %ix%i", async (w, h) => {
    const lines = await render(w, h);
    const expected = h - KEY_HINT_ROWS - HUD_ROWS;
    expect(lines[expected]).toContain("MISS YOU");
  });

  test.each(SIZES)("nothing overflows the terminal at %ix%i", async (w, h) => {
    const lines = await render(w, h);
    expect(lines.length).toBeGreaterThanOrEqual(h);
    for (const line of lines.slice(0, h)) {
      expect(line.length).toBeLessThanOrEqual(w);
    }
  });

  test.each(SIZES)("keybinds occupy the last row at %ix%i", async (w, h) => {
    const lines = await render(w, h);
    expect(lines[h - KEY_HINT_ROWS] ?? "").toContain("space");
    expect(lines[h - KEY_HINT_ROWS] ?? "").toContain("? keys");
  });

  test.each(SIZES)("transport and times render at %ix%i", async (w, h) => {
    const screen = (await render(w, h)).join("\n");
    expect(screen).toContain("1:35");
    expect(screen).toContain("3:26");
    expect(screen).toMatch(/[█░]/);
  });


  // Spotify's convention: the device is named only when playback is somewhere else.
  test("does not name the device when playing on this terminal", async () => {
    const screen = (await render(100, 32)).join("\n");
    expect(screen).toContain("PLAYING");
    expect(screen).toContain("VOL 100%");
    expect(screen).not.toContain("spotuify");
  });

  test("names the device when playing elsewhere", async () => {
    const screen = (await render(100, 32, undefined, "Austin's mini M4", false)).join("\n");
    expect(screen).toContain("PLAYING ON AUSTIN'S MINI M4");
  });

  test("a same-named remote receiver is still shown as elsewhere", async () => {
    const screen = (await render(100, 32, undefined, "spotuify", false)).join("\n");
    expect(screen).toContain("PLAYING ON SPOTUIFY");
  });

  test("long titles are truncated, not wrapped", async () => {
    // A wrapped title would push the transport off the bottom of the screen.
    const long: Track = {
      ...TRACK,
      name: "Ugly Is Beautiful: Shorter, Thicker & Uglier — Deluxe Edition Bonus Track",
    };
    const lines = await render(40, 20, long);
    const titleRow = lines[20 - KEY_HINT_ROWS - HUD_ROWS] ?? "";
    expect(titleRow.length).toBeLessThanOrEqual(40);
    expect(titleRow).toContain("…");
    // The row below must still be the artist, not a continuation of the title.
    expect(lines[20 - KEY_HINT_ROWS - HUD_ROWS + 1]).toContain("Oliver Tree");
  });

  test("overlay at 100x32", async () => {
    expect((await render(100, 32)).join("\n")).toMatchSnapshot();
  });

  test("overlay at 80x24", async () => {
    expect((await render(80, 24)).join("\n")).toMatchSnapshot();
  });
});
