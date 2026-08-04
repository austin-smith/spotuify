import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { removeLibraryItems, saveLibraryItems } from "../../api/library.ts";
import { playlistAdd, playlistList } from "../../cli/operations/playlists.ts";
import { cliSession } from "../../cli/session.ts";
import { libraryUri } from "../../cli/values.ts";
import { runTool } from "../result.ts";

const uris = z
  .array(z.string())
  .min(1)
  .describe(
    "Spotify URIs or open.spotify.com URLs of tracks, episodes, albums, shows, or audiobooks.",
  );

const playlistShape = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string(),
  owner_id: z.string(),
  owner_name: z.string(),
  mine: z.boolean().describe("Whether the signed-in user owns the playlist."),
});

export function registerLibraryTools(server: McpServer): void {
  server.registerTool(
    "save_to_library",
    {
      title: "Save to library",
      description:
        "Save tracks, episodes, albums, shows, or audiobooks to the user's Spotify library.",
      inputSchema: { uris },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool(async () => {
        const saved = args.uris.map((item) =>
          libraryUri(item, "cannot be saved to the library"),
        );
        await saveLibraryItems((await cliSession()).client, saved);
        return {
          data: { uris: saved },
          message: `Saved ${saved.length} item${saved.length === 1 ? "" : "s"}.`,
        };
      }),
  );

  server.registerTool(
    "remove_from_library",
    {
      title: "Remove from library",
      description:
        "Remove tracks, episodes, albums, shows, or audiobooks from the user's Spotify library.",
      inputSchema: { uris },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool(async () => {
        const removed = args.uris.map((item) =>
          libraryUri(item, "cannot be removed from the library"),
        );
        await removeLibraryItems((await cliSession()).client, removed);
        return {
          data: { uris: removed },
          message: `Removed ${removed.length} item${removed.length === 1 ? "" : "s"}.`,
        };
      }),
  );

  server.registerTool(
    "list_playlists",
    {
      title: "List playlists",
      description: "List the user's Spotify playlists.",
      inputSchema: {
        owned_only: z
          .boolean()
          .optional()
          .describe("List only playlists the user owns."),
      },
      outputSchema: { playlists: z.array(playlistShape) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      runTool(async () => {
        const result = await playlistList({ ownedOnly: args.owned_only });
        return { data: { playlists: result.data }, message: result.message };
      }),
  );

  server.registerTool(
    "add_playlist_items",
    {
      title: "Add playlist items",
      description: "Append tracks or episodes to a playlist the user owns.",
      inputSchema: {
        playlist: z
          .string()
          .describe("Spotify playlist URI, open.spotify.com URL, or bare playlist ID."),
        uris: z
          .array(z.string())
          .min(1)
          .describe("Spotify track or episode URIs or open.spotify.com URLs."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => playlistAdd(args.playlist, args.uris)),
  );
}
