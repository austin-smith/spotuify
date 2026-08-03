import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./ui/App.tsx";
import { TUI_RENDERER_CONFIG } from "./ui/renderer.ts";
import { VERSION } from "./version.ts";

const renderer = await createCliRenderer(TUI_RENDERER_CONFIG);
createRoot(renderer).render(<App version={VERSION} />);
