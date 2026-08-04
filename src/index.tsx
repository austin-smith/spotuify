import { createRoot } from "@opentui/react";
import { App } from "./ui/App.tsx";
import { createSpotuifyRenderer } from "./ui/renderer.ts";
import { VERSION } from "./version.ts";

const renderer = await createSpotuifyRenderer();
createRoot(renderer).render(<App version={VERSION} />);
