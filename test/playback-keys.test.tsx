import { createMockKeys, createTestRenderer } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import {
  handlePlaybackTransportKey,
  type PlaybackTransportTarget,
} from "../src/ui/keys.ts";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

function TransportInput({ target }: { target: PlaybackTransportTarget }) {
  useKeyboard((key) => {
    handlePlaybackTransportKey(key, target);
  });
  return <text>playback</text>;
}

describe("playback keyboard input", () => {
  test("decodes bare and Ctrl-modified arrows as distinct transport commands", async () => {
    const calls: Array<"next" | "previous" | number> = [];
    const target: PlaybackTransportTarget = {
      next: () => calls.push("next"),
      previous: () => calls.push("previous"),
      seekBy: (deltaMs) => calls.push(deltaMs),
    };
    setup = await createTestRenderer({ width: 40, height: 10 });
    const keys = createMockKeys(setup.renderer);
    createRoot(setup.renderer).render(<TransportInput target={target} />);
    await Bun.sleep(20);
    await setup.renderOnce();

    keys.pressArrow("left");
    keys.pressArrow("right");
    keys.pressArrow("left", { ctrl: true });
    keys.pressArrow("right", { ctrl: true });
    await Bun.sleep(20);

    expect(calls).toEqual([-5_000, 5_000, "previous", "next"]);
  });

  test("keeps Ctrl+N/P available for mode-specific navigation", async () => {
    const calls: string[] = [];
    const target: PlaybackTransportTarget = {
      next: () => calls.push("next"),
      previous: () => calls.push("previous"),
      seekBy: () => calls.push("seek"),
    };
    setup = await createTestRenderer({ width: 40, height: 10 });
    const keys = createMockKeys(setup.renderer);
    createRoot(setup.renderer).render(<TransportInput target={target} />);
    await Bun.sleep(20);
    await setup.renderOnce();

    keys.pressKey("n", { ctrl: true });
    keys.pressKey("p", { ctrl: true });
    await Bun.sleep(20);

    expect(calls).toEqual([]);
  });
});
