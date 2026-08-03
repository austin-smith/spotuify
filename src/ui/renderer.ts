import type { CliRendererConfig } from "@opentui/core";

/**
 * Keep terminal shutdown at the renderer boundary.
 *
 * OpenTUI handles Ctrl+C before mode-specific React keyboard handlers and tears the React tree
 * down for its configured process signals. Unmounting the tree then runs the playback, control
 * socket, request, and timer cleanup owned by App's effects.
 */
export const TUI_RENDERER_CONFIG = {
  exitOnCtrlC: true,
} satisfies CliRendererConfig;
