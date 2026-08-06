import { createMockKeys, createTestRenderer } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { useLibraryBrowser } from "../src/store/library-browser.ts";
import { LibraryView, libraryListHeight } from "../src/ui/LibraryView.tsx";
import { applyLibraryNavigation } from "../src/ui/library-navigation.ts";

const realFetch = globalThis.fetch;
const tokens = {
  accessToken: async () => "test-token",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

const playlist = (id: string) => ({
  id,
  name: `Playlist ${id}`,
  uri: `spotify:playlist:${id}`,
  owner: { id: "me", display_name: "Austin" },
});

const album = (id: string) => ({
  id,
  name: `Album ${id}`,
  uri: `spotify:album:${id}`,
  images: [],
  artists: [{ id: "national", name: "The National", uri: "spotify:artist:national" }],
  release_date: "2024-01-01",
  total_tracks: 9,
});

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

function activeSetup() {
  if (setup === undefined) throw new Error("library test renderer is not initialized");
  return setup;
}

function InteractiveLibrary({ width, height }: { width: number; height: number }) {
  useKeyboard((key) => {
    const library = useLibraryBrowser.getState();
    applyLibraryNavigation(key, library, {
      canChangeSection: library.depth() === 1,
      pageSize: libraryListHeight(height),
    });
  });
  return <LibraryView width={width} height={height} />;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for library state");
    await Bun.sleep(5);
  }
}

async function render(width: number, height: number): Promise<string[]> {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace("/v1", "");
    if (path === "/me/playlists") {
      return Response.json({
        items: [playlist("Road Trip"), playlist("Late Night"), playlist("Morning")],
        next: null,
      });
    }
    if (path === "/me/albums") {
      return Response.json({
        items: [{ album: album("Boxer") }, { album: album("High Violet") }],
        next: null,
      });
    }
    return Response.json({ artists: { items: [], cursors: { after: null } } });
  }) as unknown as typeof fetch;

  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(<InteractiveLibrary width={width} height={height} />);
  useLibraryBrowser.getState().configure(new SpotifyClient(tokens), "US", "me");
  useLibraryBrowser.getState().openLibrary();
  await waitFor(() => useLibraryBrowser.getState().loaded());
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  globalThis.fetch = realFetch;
  useLibraryBrowser.getState().closeLibrary();
});

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [120, 40],
  [100, 32],
  [80, 24],
  [60, 20],
];

describe("library view", () => {
  test.each(SIZES)("keeps its complete chrome inside %ix%i", async (width, height) => {
    const lines = await render(width, height);
    const screen = lines.join("\n");
    expect(screen).toContain("LIBRARY");
    expect(screen).toContain("PLAYLISTS");
    expect(screen).toContain("ALBUMS");
    expect(screen).toContain("ARTISTS");
    expect(screen).toContain("filter playlists");
    for (const line of lines.slice(0, height)) expect(line.length).toBeLessThanOrEqual(width);
  });

  test("real typing filters the complete playlist list locally", async () => {
    await render(80, 24);
    const current = activeSetup();
    const keys = createMockKeys(current.renderer);
    await keys.typeText("late", 5);
    await Bun.sleep(20);
    await current.renderOnce();

    expect(useLibraryBrowser.getState().text()).toBe("late");
    const screen = current.captureCharFrame();
    expect(screen).toContain("Playlist Late Night");
    expect(screen).not.toContain("Playlist Road Trip");
  });

  test("Tab changes section while the filter remains ready for typing", async () => {
    await render(80, 24);
    const current = activeSetup();
    const keys = createMockKeys(current.renderer);
    keys.pressTab();
    await waitFor(() => useLibraryBrowser.getState().loaded());
    await current.renderOnce();
    expect(useLibraryBrowser.getState().section).toBe("albums");

    await keys.typeText("violet", 5);
    await Bun.sleep(20);
    await current.renderOnce();
    expect(useLibraryBrowser.getState().text()).toBe("violet");
    const screen = current.captureCharFrame();
    expect(screen).toContain("Album High Violet");
    expect(screen).toContain("The National");
  });

  test("the selected row carries playlist owner context", async () => {
    const screen = (await render(80, 24)).join("\n");
    expect(screen).toContain("Playlist Road Trip");
    expect(screen).toContain("Austin");
    expect(screen.split("\n").filter((line) => line.includes("▌"))).toHaveLength(1);
  });
});
