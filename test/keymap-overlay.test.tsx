import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import type { EngineStatus } from "../src/engine/librespot.ts";
import { KeymapOverlay } from "../src/ui/KeymapOverlay.tsx";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

const SUPPORTED_SIZES = [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 40],
] as const;

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
  account = "Austin",
  updateVersion: string | null = null,
): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <KeymapOverlay
      width={width}
      height={height}
      version="0.1.0"
      account={account}
      engine={engine}
      webAccountId={webAccountId}
      canBrowse={canBrowse}
      updateVersion={updateVersion}
    />,
  );
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

describe("keymap engine status", () => {
  test("shows the product version in the header", async () => {
    const lines = await render(80, 24, { state: "missing" });
    const screen = lines.join("\n");
    const header = lines.find((line) => line.includes("SPOTUIFY")) ?? "";
    const rule = lines.find((line) => line.includes("──")) ?? "";

    expect(screen).toContain("SPOTUIFY v0.1.0");
    expect(header.indexOf("SPOTUIFY")).toBe(rule.indexOf("─"));
    expect(header.indexOf("Austin") + "Austin".length - 1).toBe(rule.lastIndexOf("─"));
  });

  test.each(SUPPORTED_SIZES)(
    "keeps an available update inside the measured keymap at %ix%i",
    async (width, height) => {
      const lines = await render(
        width,
        height,
        { state: "ready", pid: 42, deviceId: "receiver", accountId: "account" },
        true,
        "account",
        "Austin",
        "1.2.3",
      );
      const screen = lines.join("\n");
      expect(screen).toContain("v1.2.3 available");
      expect(screen).toContain("spotuify update");
      expect(screen).toContain("esc close");
      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  test("remeasures omitted groups when a live terminal switches to one column", async () => {
    setup = await createTestRenderer({ width: 120, height: 40 });
    const root = createRoot(setup.renderer);
    const keymap = (width: number) => (
      <KeymapOverlay
        width={width}
        height={40}
        version="0.1.0"
        account="Austin"
        engine={{ state: "ready", pid: 42, deviceId: "receiver", accountId: "account" }}
        webAccountId="account"
      />
    );

    root.render(keymap(120));
    await Bun.sleep(20);
    await setup.renderOnce();
    setup.resize(60, 40);
    root.render(keymap(60));
    await Bun.sleep(20);
    await setup.renderOnce();

    const screen = setup.captureCharFrame();
    expect(screen).toContain("SEARCH");
    expect(screen).toContain("LISTS");
    expect(screen).toContain("esc close");
  });

  test("keeps long shortcut labels from wrapping into adjacent keymap rows", async () => {
    const lines = await render(80, 32, {
      state: "ready",
      pid: 42,
      deviceId: "receiver",
      accountId: "account",
    });
    const screen = lines.join("\n");

    expect(screen).toContain("LISTS");
    // The gap encodes the key column width: longest shortcut (`tab / shift+tab`, 15 cells) plus 2.
    expect(screen).toContain("pgup/pgdn        a page");
    expect(screen).not.toContain("look again");
    expect(screen).not.toContain("↑/↓LYRICscroll");
    for (const line of lines.slice(0, 32)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  // Overflowing columns drop whole groups silently; growing the keymap once hid `q quit` at 80×24.
  test.each(SUPPORTED_SIZES)("keeps every key group visible at %ix%i", async (width, height) => {
    const screen = (
      await render(width, height, {
        state: "ready",
        pid: 42,
        deviceId: "receiver",
        accountId: "account",
      })
    ).join("\n");

    for (const group of ["PLAYBACK", "BROWSE", "LISTS", "SEARCH"]) {
      expect(screen).toContain(group);
    }
    // 60×20 has never fit the APP group; the guard here is that nothing else joins it.
    if (height >= 24) expect(screen).toContain("APP");
  });

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
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  test("keeps brand and version while truncating a wide Unicode account at compact size", async () => {
    const account = "Austin界面🎧".repeat(12);
    const lines = await render(60, 20, { state: "missing" }, true, "account", account);
    const screen = lines.join("\n");
    const header = lines.find((line) => line.includes("SPOTUIFY")) ?? "";

    expect(header).toContain("SPOTUIFY v0.1.0");
    expect(header).toContain("Austin");
    expect(header).toContain("…");
    expect(header).not.toContain(account);
    for (const line of lines.slice(0, 20)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
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
    expect(screen).not.toContain("save / unsave");
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
