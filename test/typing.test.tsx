import { createMockKeys, createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { SpotifyClient } from "../src/api/client.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import { useSearch } from "../src/store/search.ts";
import { Palette } from "../src/ui/Palette.tsx";

/**
 * Drives the palette through real keystrokes.
 *
 * This exists because every other test seeded the store directly and so passed while the app was
 * broken: OpenTUI's `<input>` fires `onInput` per keystroke but `onChange` only later, so the store
 * held an empty query while the field showed typed text, and Enter acted on the home list.
 */

const realFetch = globalThis.fetch;

const tokens = {
  accessToken: async () => "t",
  refresh: async () => {
    throw new Error("unexpected refresh");
  },
} as unknown as TokenStore;

const track = (id: string, name: string) => ({
  id,
  name,
  uri: `spotify:track:${id}`,
  duration_ms: 200_000,
  artists: [{ id: "a", name: "Artist", uri: "spotify:artist:a" }],
  album: { id: "x", name: "Album", uri: "spotify:album:x", images: [] },
});

function stubApi() {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (path.includes("recently-played")) return json({ items: [{ track: track("H", "HOME TRACK") }] });
    if (path.includes("/me/top/tracks")) return json({ items: [] });
    if (path.includes("/search")) return json({ tracks: { items: [track("S", "SEARCH TRACK")] } });
    return json({});
  }) as unknown as typeof fetch;
}

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  globalThis.fetch = realFetch;
  useSearch.getState().closePalette();
});

async function openAndType(text: string) {
  stubApi();
  setup = await createTestRenderer({ width: 90, height: 20 });
  const keys = createMockKeys(setup.renderer);
  createRoot(setup.renderer).render(<Palette width={90} height={20} />);

  useSearch.getState().configure(new SpotifyClient(tokens), "US");
  useSearch.getState().openPalette();
  await Bun.sleep(60);
  await setup.renderOnce();

  if (text.length > 0) {
    await keys.typeText(text, 5);
    // Past the 220ms debounce plus the stubbed request.
    await Bun.sleep(700);
    await setup.renderOnce();
  }
  return setup.captureCharFrame();
}

describe("typing into the palette", () => {
  test("keystrokes reach the store", async () => {
    await openAndType("search");
    expect(useSearch.getState().query).toBe("search");
  });

  test("the list becomes search results, not the home view", async () => {
    const screen = await openAndType("search");
    expect(screen).toContain("SEARCH TRACK");
    expect(screen).not.toContain("HOME TRACK");
    expect(screen).not.toContain("RECENTLY PLAYED");
  });

  // The reported bug: Enter played a home item because the store never saw the query.
  test("the selected row is a search result", async () => {
    await openAndType("search");
    const current = useSearch.getState().current();
    expect(current?.label).toBe("SEARCH TRACK");
    expect(current?.play).toEqual({ uris: ["spotify:track:S"] });
  });

  test("the home view is what shows before typing", async () => {
    const screen = await openAndType("");
    expect(screen).toContain("HOME TRACK");
    expect(useSearch.getState().current()?.label).toBe("HOME TRACK");
  });

  test("clearing the query returns to the home view", async () => {
    await openAndType("search");
    useSearch.getState().setQuery("");
    await Bun.sleep(30);
    expect(useSearch.getState().current()?.label).toBe("HOME TRACK");
  });
});
