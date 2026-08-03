import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { setupScreenLayout, SetupScreen } from "../src/ui/SetupScreen.tsx";

const SUPPORTED_SIZES = [
  [60, 20],
  [80, 24],
  [100, 32],
  [120, 40],
] as const;

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(
  width: number,
  height: number,
  updateAvailable: boolean,
  authCommand = "spotuify auth",
): Promise<string[]> {
  setup = await createTestRenderer({ width, height });
  createRoot(setup.renderer).render(
    <SetupScreen
      updateAvailable={updateAvailable}
      width={width}
      height={height}
      authCommand={authCommand}
    />,
  );
  await Bun.sleep(20);
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

describe("setup screen layout", () => {
  test("measures a wrapped heading before allocating branding", () => {
    const layout = setupScreenLayout("spotuify auth", false, 18, 8);

    expect(layout.headingLines).toEqual(["Setup", "required."]);
    expect(layout.brandHeight).toBe(0);
    expect(layout.brandGapHeight).toBe(0);
    expect(layout.instructionGapHeight).toBe(0);
    expect(layout.footerGapHeight).toBe(0);
  });

  test("keeps the complete setup handoff visible when the heading wraps", async () => {
    const lines = await render(18, 8, false);
    const screen = lines.join("\n");
    const copy = screen.replace(/\s+/g, " ").trim();

    expect(screen).not.toContain("SPOTUIFY");
    expect(copy).toContain(
      "Setup required. Run spotuify auth to get started. q to quit.",
    );
    expect(lines[6]).toContain("q to quit.");

    for (const line of lines.slice(0, 8)) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(18);
    }
  });

  test("measures wrapped handoff copy before choosing the brand treatment", () => {
    const authCommand = `${"authenticate-with-a-long-command ".repeat(14)}ENDOFHANDOFF`;
    const layout = setupScreenLayout(authCommand, true, 80, 18);

    expect(layout.instructionHeight).toBeGreaterThan(6);
    expect(layout.brandHeight).toBe(1);
  });

  test("keeps a wrapped setup handoff intact at 80x18", async () => {
    const authCommand = `${"authenticate-with-a-long-command ".repeat(14)}ENDOFHANDOFF`;
    const lines = await render(80, 18, true, authCommand);
    const screen = lines.join("\n");

    expect(screen).toContain("SPOTUIFY");
    expect(screen).not.toContain("███████╗");
    expect(screen).toContain("ENDOFHANDOFF");
    expect(screen).toContain("Update available — run: spotuify update");
    expect(lines[16]).toContain("q to quit.");
  });

  test.each(SUPPORTED_SIZES)(
    "shows the setup handoff at %ix%i",
    async (width, height) => {
      const lines = await render(width, height, true);
      const screen = lines.join("\n");

      expect(screen).toContain(width >= 80 ? "███████╗" : "SPOTUIFY");
      expect(screen).toContain("Setup required.");
      expect(screen).toContain("Run spotuify auth to get started.");
      expect(screen).not.toContain("developer.spotify.com");
      expect(screen).not.toContain("SPOTUIFY_CLIENT_ID");
      expect(screen).toContain("Update available — run: spotuify update");
      expect(screen).toContain("q to quit.");
      expect(lines[height - 2]).toContain("q to quit.");

      for (const line of lines.slice(0, height)) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  test.each(SUPPORTED_SIZES)(
    "keeps quit visible without an update at %ix%i",
    async (width, height) => {
      const lines = await render(width, height, false);
      const screen = lines.join("\n");

      expect(screen).toContain("Setup required.");
      expect(screen).toContain("Run spotuify auth to get started.");
      expect(screen).not.toContain("Update available");
      expect(lines[height - 2]).toContain("q to quit.");
    },
  );
});
