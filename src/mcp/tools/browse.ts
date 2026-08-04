import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  lyricsFor,
  resourceDetails,
  searchCatalog,
  SEARCH_LIMIT_MAX,
} from "../../cli/operations/catalog.ts";
import { runTool } from "../result.ts";

const SEARCH_TYPES = [
  "track",
  "artist",
  "album",
  "playlist",
  "show",
  "episode",
  "audiobook",
] as const;

export function registerBrowseTools(server: McpServer): void {
  server.registerTool(
    "search",
    {
      title: "Search Spotify",
      description:
        "Search the Spotify catalog for tracks, artists, albums, playlists, shows, episodes, or audiobooks.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text search query."),
        types: z
          .array(z.enum(SEARCH_TYPES))
          .min(1)
          .optional()
          .describe(
            "Resource types to search. Defaults to track, artist, album, and playlist.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .optional()
          .describe("Results per resource type, up to 50."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(() =>
        searchCatalog(args.query, {
          ...(args.types !== undefined ? { types: args.types } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "get_resource",
    {
      title: "Get resource",
      description:
        "Get details and playable contents for a Spotify track, episode, album, artist, playlist, show, or audiobook. Playlist contents are listed only for playlists the user owns.",
      inputSchema: {
        target: z
          .string()
          .describe("Spotify URI or open.spotify.com URL of the resource."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      runTool(async () => {
        // Every branch of the details switch returns an object, matching the CLI `show` data.
        const result = await resourceDetails(args.target);
        return {
          data: result.data as Record<string, unknown>,
          message: result.message,
        };
      }),
  );

  server.registerTool(
    "get_lyrics",
    {
      title: "Get lyrics",
      description:
        "Get lyrics for a track, or for the currently playing track when no track is given.",
      inputSchema: {
        track: z
          .string()
          .optional()
          .describe(
            "Spotify track URI or URL. Omit to use the currently playing track.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) => runTool(() => lyricsFor(args.track)),
  );
}
