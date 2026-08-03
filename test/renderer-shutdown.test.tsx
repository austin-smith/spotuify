import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, useKeyboard } from "@opentui/react";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect } from "react";
import { TUI_RENDERER_CONFIG } from "../src/ui/renderer.ts";

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

function ModeSpecificInput({ onCleanup }: { onCleanup: () => void }) {
  useEffect(() => onCleanup, [onCleanup]);
  // App has one keyboard handler with early returns for each active overlay. This intentionally
  // inert handler represents any such mode and proves it cannot intercept renderer-owned Ctrl+C.
  useKeyboard(() => {});
  return <text>overlay active</text>;
}

describe("renderer shutdown", () => {
  test("Ctrl+C destroys the renderer and unmounts React from any input mode", async () => {
    let cleanedUp = false;
    setup = await createTestRenderer({
      width: 40,
      height: 10,
      ...TUI_RENDERER_CONFIG,
    });
    createRoot(setup.renderer).render(
      <ModeSpecificInput onCleanup={() => (cleanedUp = true)} />,
    );
    await Bun.sleep(20);
    await setup.renderOnce();

    setup.mockInput.pressCtrlC();
    await Bun.sleep(20);

    expect(setup.renderer.isDestroyed).toBe(true);
    expect(cleanedUp).toBe(true);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} destroys the renderer, runs React cleanup, and releases the process`, async () => {
      if (process.platform === "win32") return;

      const directory = await mkdtemp(join(tmpdir(), "spotuify-renderer-shutdown-"));
      const ready = join(directory, "ready");
      const cleaned = join(directory, "cleaned");
      const harness = fileURLToPath(
        new URL("fixtures/renderer-shutdown-harness.tsx", import.meta.url),
      );

      try {
        const child = Bun.spawn([process.execPath, harness, ready, cleaned], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const deadline = performance.now() + 2_000;
        while (!existsSync(ready)) {
          if (performance.now() >= deadline) {
            child.kill("SIGKILL");
            await child.exited;
            const stderr = await new Response(child.stderr).text();
            throw new Error(`shutdown harness did not become ready: ${stderr}`);
          }
          await Bun.sleep(5);
        }

        child.kill(signal);
        const exitCode = await Promise.race([
          child.exited,
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), 1_500),
          ),
        ]);
        if (exitCode === "timeout") {
          child.kill("SIGKILL");
          await child.exited;
        }
        const stderr = await new Response(child.stderr).text();

        expect(exitCode, stderr).toBe(0);
        expect(existsSync(cleaned)).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
