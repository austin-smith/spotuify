import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { writeFileSync } from "node:fs";
import { useEffect } from "react";
import { TUI_RENDERER_CONFIG } from "../../src/ui/renderer.ts";

function requiredArgument(index: number): string {
  const value = process.argv[index];
  if (value === undefined) throw new Error("ready and cleanup marker paths are required");
  return value;
}
const readyPath = requiredArgument(2);
const cleanedPath = requiredArgument(3);

function Probe() {
  useEffect(() => {
    const keepAlive = setInterval(() => {}, 1_000);
    writeFileSync(readyPath, "ready");
    return () => {
      clearInterval(keepAlive);
      writeFileSync(cleanedPath, "cleaned");
    };
  }, []);
  return <text>ready</text>;
}

const setup = await createTestRenderer({
  width: 20,
  height: 5,
  ...TUI_RENDERER_CONFIG,
});
createRoot(setup.renderer).render(<Probe />);
await Bun.sleep(20);
await setup.renderOnce();
