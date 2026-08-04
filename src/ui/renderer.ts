import type { CliRendererConfig } from "@opentui/core";
import { clearTerminalTitle } from "./terminal-title.ts";

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
