import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, expect, test } from "bun:test";
import type { Track } from "../src/api/types.ts";
import type { PendingPlaybackSelection } from "../src/store/playback.ts";
import { PlaybackStage } from "../src/ui/PlaybackStage.tsx";

const TRACK: Track = {
  id: "track",
  name: "Selected Track",
  uri: "spotify:track:selected",
  duration_ms: 180_000,
  artists: [{ id: "artist", name: "Artist", uri: "spotify:artist:artist" }],
  album: { id: "album", name: "Album", uri: "spotify:album:album", images: [] },
};

const PENDING: PendingPlaybackSelection = {
  requestId: 1,
  label: TRACK.name,
  item: TRACK,
  confirmation: { kind: "item", uri: TRACK.uri },
  requiresFollowUp: false,
  lane: "web",
};

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

function stage(item: Track | null, pendingSelection: PendingPlaybackSelection | null) {
  return (
    <PlaybackStage
      item={item}
      pendingSelection={pendingSelection}
      progressMs={1_000}
      durationMs={TRACK.duration_ms}
      isPlaying={item !== null}
      shuffle={false}
      repeat="off"
      volumePercent={50}
      deviceName="spotuify"
      isLocalDevice
      ready
      canSearch
      overlayOpen={false}
      width={100}
      height={31}
    />
  );
}

test("empty → starting → playing never returns to the empty surface", async () => {
  setup = await createTestRenderer({ width: 100, height: 32 });
  const root = createRoot(setup.renderer);

  root.render(stage(null, null));
  await Bun.sleep(20);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("NOTHING PLAYING");

  root.render(stage(null, PENDING));
  await Bun.sleep(20);
  await setup.renderOnce();
  const starting = setup.captureCharFrame();
  expect(starting).toContain("SELECTED TRACK");
  expect(starting).toContain("STARTING");
  expect(starting).not.toContain("NOTHING PLAYING");

  // Metadata can arrive before the transition's final acknowledgment. It is still a transition,
  // not a paused track and not an empty canvas.
  root.render(stage(TRACK, PENDING));
  await Bun.sleep(20);
  await setup.renderOnce();
  const identified = setup.captureCharFrame();
  expect(identified).toContain("SELECTED TRACK");
  expect(identified).toContain("STARTING");
  expect(identified).not.toContain("PAUSED");
  expect(identified).not.toContain("NOTHING PLAYING");

  root.render(stage(TRACK, null));
  await Bun.sleep(20);
  await setup.renderOnce();
  const playing = setup.captureCharFrame();
  expect(playing).toContain("SELECTED TRACK");
  expect(playing).toContain("PLAYING");
  expect(playing).not.toContain("NOTHING PLAYING");
});

test("a context without track metadata gets a restrained starting surface", async () => {
  setup = await createTestRenderer({ width: 80, height: 24 });
  createRoot(setup.renderer).render(
    stage(null, {
      requestId: 2,
      label: "Daily Mix",
      item: null,
      confirmation: { kind: "context", uri: "spotify:playlist:daily-mix" },
      requiresFollowUp: true,
      lane: "web",
    }),
  );
  await Bun.sleep(20);
  await setup.renderOnce();

  const screen = setup.captureCharFrame();
  expect(screen).toContain("STARTING…");
  expect(screen).toContain("Daily Mix");
  expect(screen).not.toContain("NOTHING PLAYING");
  expect(screen).not.toContain("███████╗");
});
