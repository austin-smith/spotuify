import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./ui/App.tsx";
import { VERSION } from "./version.ts";

// Ctrl+C is handled in App so we can tear the renderer down cleanly and restore the terminal.
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App version={VERSION} />);
