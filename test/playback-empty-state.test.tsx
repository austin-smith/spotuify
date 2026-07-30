import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { PlaybackEmptyState } from "../src/ui/PlaybackEmptyState.tsx";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function renderEmptyState(
  ready: boolean,
  canSearch: boolean,
  width = 90,
): Promise<string> {
  setup = await createTestRenderer({ width, height: 20 });
  createRoot(setup.renderer).render(
    <PlaybackEmptyState ready={ready} canSearch={canSearch} height={20} />,
  );
  await Bun.sleep(10);
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("empty playback guidance", () => {
  test("points to search only when search is available", async () => {
    expect(await renderEmptyState(true, true)).toContain(
      "NOTHING PLAYING — press / to find something",
    );
  });

  test("explains why account-bound controls are unavailable in profile-less quota mode", async () => {
    const screen = await renderEmptyState(true, false, 60);

    expect(screen).toContain("WEB API LIMITED — press r to retry account verification");
    expect(screen).not.toContain("press /");
    expect(screen).not.toContain("press d");
  });

  test("preserves the loading state", async () => {
    expect(await renderEmptyState(false, false)).toContain("LOADING…");
  });
});
