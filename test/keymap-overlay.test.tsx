import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { EngineStatus } from "../src/engine/librespot.ts";
import { KeymapOverlay } from "../src/ui/KeymapOverlay.tsx";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(
  width: number,
  height: number,
  engine: EngineStatus,
  canBrowse = true,
  webAccountId: string | null = canBrowse ? "account" : null,
): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <KeymapOverlay
      width={width}
      height={height}
      account="Austin"
      product="premium"
      engine={engine}
      webAccountId={webAccountId}
      canBrowse={canBrowse}
    />,
  );
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

describe("keymap engine status", () => {
  test("describes a ready local receiver without the ambiguous activation message", async () => {
    const screen = (await render(80, 24, {
      state: "ready",
      pid: 42,
      deviceId: "receiver",
      accountId: "account",
    })).join("\n");
    expect(screen).toContain("local playback ready");
    expect(screen).not.toContain("activate in Spotify");
  });

  test("gives the exact build command when the sidecar is missing", async () => {
    const screen = (await render(80, 24, { state: "missing" })).join("\n");
    expect(screen).toContain("run: bun run engine:build");
  });

  test("a long failure remains inside the terminal at supported compact sizes", async () => {
    const lines = await render(60, 20, {
      state: "failed",
      reason:
        "an intentionally very long diagnostic that must be truncated instead of wrapping over the keymap",
    });
    expect(lines.join("\n")).toContain("local playback failed");
    for (const line of lines.slice(0, 20)) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  test("profile-less quota mode omits actions that require an unverified account", async () => {
    const screen = (
      await render(
        80,
        24,
        { state: "ready", pid: 42, deviceId: "receiver", accountId: "account" },
        false,
      )
    ).join("\n");

    expect(screen).not.toContain("search");
    expect(screen).not.toContain("go to");
    expect(screen).not.toContain("device");
    expect(screen).toContain("retry account");
    expect(screen).toContain("waiting for account verification");
  });

  test("explains how to repair a native login for another account", async () => {
    const screen = (
      await render(
        90,
        24,
        { state: "ready", pid: 42, deviceId: "receiver", accountId: "other-account" },
        true,
        "account",
      )
    ).join("\n");

    expect(screen).toContain("local playback account mismatch");
    expect(screen).toContain("spotuify auth --force-engine");
  });
});
