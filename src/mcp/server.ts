import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Writable } from "node:stream";
import { VERSION } from "../version.ts";
import { registerBrowseTools } from "./tools/browse.ts";
import { registerLibraryTools } from "./tools/library.ts";
import { registerPlaybackTools } from "./tools/playback.ts";

const INSTRUCTIONS = `Control the user's Spotify account: playback, queue, devices, search, lyrics, library, and playlists.

- Wherever a target, uri, or playlist parameter appears, pass a Spotify URI (spotify:track:...) or an open.spotify.com URL. Find URIs with search, get_resource, or list_playlists.
- device parameters accept a Spotify Connect device ID or name from list_devices; omit them to use the active device.
- Relative changes use offset_ms (seek) and delta (set_volume); absolute values use position_ms and percent.
- Authentication happens outside this server. When a tool reports an authentication error, ask the user to run \`spotuify auth\` in a terminal.
- Playback control requires Spotify Premium and a reachable device. Rate-limit errors include the time to retry after.
- Structured tool results use the same snake_case shapes as the \`spotuify --json\` CLI output.`;

/**
 * Build the MCP server with every tool registered but no transport attached.
 *
 * Session creation is lazy: initialize and tools/list succeed without credentials, and the first
 * tool call surfaces a missing login as a tool error rather than an interactive flow. The server
 * is strictly a runtime client — it never starts a playback runtime of its own, so it coexists
 * with a running TUI, a headless service, and other MCP server instances.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "spotuify", title: "Spotuify", version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerPlaybackTools(server);
  registerBrowseTools(server);
  registerLibraryTools(server);
  return server;
}

/**
 * Serve MCP over stdio until the client disconnects or a signal arrives.
 *
 * Stdout belongs to the protocol from the moment the transport connects; the ready line and any
 * diagnostics go to stderr. Shutdown never calls `process.exit()`: closing the transport releases
 * stdin and the process leaves through the CLI's normal exit path.
 */
export async function runMcpServer(io: {
  stderr: Writable;
}): Promise<{ interrupted: boolean }> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  let interrupted = false;
  const closed = new Promise<void>((resolve) => {
    // The protocol fires this for both peer shutdown (stdin closed) and server.close().
    server.server.onclose = resolve;
  });
  const onSignal = () => {
    interrupted = true;
    void server.close();
  };
  // The MCP stdio shutdown sequence is the client closing our stdin; the SDK transport only
  // watches for data, so end-of-input has to close the server here or the process would linger
  // until the client escalates to signals.
  const onStdinEnd = () => {
    void server.close();
  };
  await server.connect(transport);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdin.once("end", onStdinEnd);
  io.stderr.write(`spotuify ${VERSION} MCP server ready on stdio\n`);
  try {
    await closed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdin.off("end", onStdinEnd);
  }
  return { interrupted };
}
