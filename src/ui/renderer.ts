import {
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import type { Writable } from "node:stream";
import {
  clearTerminalTitle,
  setSpotuifyTerminalTitle,
} from "./terminal-title.ts";

type RendererFactory = (config: CliRendererConfig) => Promise<CliRenderer>;

interface CreateSpotuifyRendererOptions {
  createRenderer?: RendererFactory;
  output?: Writable;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Keep terminal shutdown at the renderer boundary.
 *
 * OpenTUI handles Ctrl+C before mode-specific React keyboard handlers and tears the React tree
 * down for its configured process signals. Unmounting the tree then runs the playback, control
 * socket, request, and timer cleanup owned by App's effects.
 */
export const TUI_RENDERER_CONFIG = {
  exitOnCtrlC: true,
  // OpenTUI restores stdout before this callback, so the OSC sequence reaches the terminal rather
  // than being captured as renderer output.
  onDestroy: clearTerminalTitle,
} satisfies CliRendererConfig;

export async function createSpotuifyRenderer({
  createRenderer = createCliRenderer,
  output = process.stdout,
  environment = process.env,
}: CreateSpotuifyRendererOptions = {}): Promise<CliRenderer> {
  let titleIsSet = setSpotuifyTerminalTitle(output, environment);
  const clearTitle = (): void => {
    if (!titleIsSet) return;
    titleIsSet = false;
    clearTerminalTitle(output, environment);
  };

  try {
    return await createRenderer({
      ...TUI_RENDERER_CONFIG,
      onDestroy: clearTitle,
    });
  } catch (error) {
    try {
      clearTitle();
    } finally {
      throw error;
    }
  }
}
