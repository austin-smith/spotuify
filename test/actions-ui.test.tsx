import { createMockKeys, createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { Track } from "../src/api/types.ts";
import { useActions, type ActionEntry } from "../src/store/actions.ts";
import { ActionsMenu } from "../src/ui/ActionsMenu.tsx";
import { PlaylistPicker } from "../src/ui/PlaylistPicker.tsx";

const item: Track = {
  id: "track",
  name: "A Carefully Chosen Track",
  uri: "spotify:track:track",
  duration_ms: 200_000,
  artists: [{ id: "artist", name: "Artist", uri: "spotify:artist:artist" }],
  album: { id: "album", name: "Album", uri: "spotify:album:album", images: [] },
};

const entries: ActionEntry[] = [
  {
    id: "album:album",
    kind: "drill",
    label: "go to album",
    detail: "Album",
    disabled: false,
    drill: {
      kind: "album",
      id: "album",
      name: "Album",
      uri: "spotify:album:album",
    },
  },
  {
    id: "artist:artist",
    kind: "drill",
    label: "go to artist",
    detail: "Artist",
    disabled: false,
    drill: { kind: "artist", id: "artist", name: "Artist" },
  },
  {
    id: "add-to-playlist",
    kind: "playlist",
    label: "add to playlist",
    detail: "choose a destination",
    disabled: false,
  },
  {
    id: "library",
    kind: "library",
    label: "save to liked songs",
    detail: "",
    disabled: false,
    saved: false,
  },
];

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  useActions.getState().closeActions();
  useActions.getState().clearNotice();
});

async function render(
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

describe("actions overlay", () => {
  test.each([
    [100, 32],
    [80, 24],
    [60, 20],
  ])("stays inside the terminal at %ix%i", async (width, height) => {
    useActions.setState({
      open: true,
      mode: "actions",
      target: item,
      entries,
      selected: 2,
      savedLoading: false,
      busy: false,
      error: null,
    });

    const lines = await render(<ActionsMenu width={width} height={height} />, width, height);
    const screen = lines.join("\n");
    expect(screen).toContain("add to playlist");
    expect(screen).toContain("save to liked songs");
    for (const line of lines.slice(0, height)) expect(line.length).toBeLessThanOrEqual(width);
  });

  test("surfaces membership failures in the overlay status", async () => {
    useActions.setState({
      open: true,
      mode: "actions",
      target: item,
      entries,
      selected: 0,
      savedLoading: false,
      busy: false,
      error: "spotify is limiting this request",
    });

    const screen = (await render(<ActionsMenu width={80} height={24} />, 80, 24)).join("\n");
    expect(screen).toContain("spotify is limiting this request");
  });
});

describe("playlist picker", () => {
  const playlists = [
    {
      id: "road",
      name: "Road Trip",
      uri: "spotify:playlist:road",
      ownerId: "me",
      ownerName: "Me",
      mine: true,
    },
    {
      id: "night",
      name: "Late Night Drive",
      uri: "spotify:playlist:night",
      ownerId: "me",
      ownerName: "Me",
      mine: true,
    },
  ];

  test("real keystrokes update the playlist filter", async () => {
    useActions.setState({
      open: true,
      mode: "playlists",
      target: item,
      playlists,
      playlistsLoading: false,
      playlistQuery: "",
      playlistSelected: 0,
      busy: false,
      error: null,
    });
    setup = await createTestRenderer({ width: 80, height: 24 });
    const keys = createMockKeys(setup.renderer);
    createRoot(setup.renderer).render(<PlaylistPicker width={80} height={24} />);
    await Bun.sleep(20);
    await setup.renderOnce();

    await keys.typeText("night", 5);
    await Bun.sleep(30);
    await setup.renderOnce();

    expect(useActions.getState().playlistQuery).toBe("night");
    const screen = setup.captureCharFrame();
    expect(screen).toContain("Late Night Drive");
    expect(screen).not.toContain("Road Trip");
  });

  test("does not accept filter edits while an add is pending", async () => {
    useActions.setState({
      open: true,
      mode: "playlists",
      target: item,
      playlists,
      playlistsLoading: false,
      playlistQuery: "",
      playlistSelected: 0,
      busy: true,
      error: null,
    });
    setup = await createTestRenderer({ width: 80, height: 24 });
    const keys = createMockKeys(setup.renderer);
    createRoot(setup.renderer).render(<PlaylistPicker width={80} height={24} />);
    await Bun.sleep(20);
    await setup.renderOnce();

    await keys.typeText("night", 5);
    await Bun.sleep(30);

    expect(useActions.getState().playlistQuery).toBe("");
  });

  test.each([
    [100, 32],
    [80, 24],
    [60, 20],
  ])("stays inside the terminal at %ix%i", async (width, height) => {
    useActions.setState({
      open: true,
      mode: "playlists",
      target: item,
      playlists,
      playlistsLoading: false,
      playlistQuery: "",
      playlistSelected: 1,
      busy: false,
      error: null,
    });

    const lines = await render(<PlaylistPicker width={width} height={height} />, width, height);
    expect(lines.join("\n")).toContain("filter playlists");
    for (const line of lines.slice(0, height)) expect(line.length).toBeLessThanOrEqual(width);
  });
});
