import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { usageError } from "../../cli/errors.ts";
import { deviceList, deviceTransfer } from "../../cli/operations/devices.ts";
import {
  pausePlayback,
  playbackStatus,
  seekPlayback,
  setRepeat,
  setShuffle,
  setVolume,
  skip,
  startPlayback,
} from "../../cli/operations/playback.ts";
import { queueAdd, queueList } from "../../cli/operations/queue.ts";
import { runTool } from "../result.ts";

const device = z
  .string()
  .optional()
  .describe(
    "Target Spotify Connect device, by ID or name from list_devices. Omit to use the active device.",
  );

const playbackItemShape = z
  .record(z.string(), z.unknown())
  .nullable()
  .describe("The current track or episode, or null when nothing is loaded.");

const playbackDeviceShape = z
  .object({
    id: z.string().nullable(),
    name: z.string(),
    type: z.string().nullable(),
    volume_percent: z.number().nullable(),
    is_restricted: z.boolean().nullable(),
  })
  .nullable();

const PLAYBACK_STATUS_OUTPUT = {
  active: z.boolean().describe("Whether any playback session exists."),
  is_playing: z.boolean(),
  item: playbackItemShape,
  progress_ms: z.number().nullable(),
  duration_ms: z.number().nullable(),
  shuffle: z.boolean(),
  repeat: z.enum(["off", "context", "track"]),
  context_uri: z.string().nullable(),
  device: playbackDeviceShape,
};

const queueItemShape = z.object({
  type: z.string(),
  id: z.string().nullable(),
  uri: z.string(),
  name: z.string(),
  artists: z.array(z.string()),
  artist: z.string(),
  album: z.string().nullable(),
  show: z.string().nullable(),
  duration_ms: z.number().nullable(),
});

const deviceShape = z.looseObject({
  id: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  is_active: z.boolean(),
  is_restricted: z.boolean(),
  volume_percent: z.number().nullable(),
});

export function registerPlaybackTools(server: McpServer): void {
  server.registerTool(
    "playback_status",
    {
      title: "Playback status",
      description:
        "Get the current Spotify playback state: track, device, progress, shuffle, and repeat.",
      inputSchema: {},
      outputSchema: PLAYBACK_STATUS_OUTPUT,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => runTool(() => playbackStatus()),
  );

  server.registerTool(
    "play",
    {
      title: "Play",
      description:
        "Resume playback, or play a Spotify track, episode, album, artist, or playlist by URI or open.spotify.com URL.",
      inputSchema: {
        target: z
          .string()
          .optional()
          .describe(
            "Spotify URI or URL to play. Omit to resume the current playback.",
          ),
        device,
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("One-based item position within an album or playlist target."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => startPlayback(args)),
  );

  server.registerTool(
    "pause",
    {
      title: "Pause",
      description: "Pause Spotify playback.",
      inputSchema: { device },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => pausePlayback(args)),
  );

  server.registerTool(
    "skip",
    {
      title: "Skip",
      description: "Skip to the next item or return to the previous item.",
      inputSchema: {
        direction: z.enum(["next", "previous"]),
        device,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => skip(args.direction, { device: args.device })),
  );

  server.registerTool(
    "seek",
    {
      title: "Seek",
      description:
        "Seek within the current item: position_ms jumps to an absolute time, offset_ms moves by a signed amount. Provide exactly one.",
      inputSchema: {
        position_ms: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Absolute position in milliseconds."),
        offset_ms: z
          .number()
          .int()
          .optional()
          .describe("Signed offset in milliseconds, e.g. -5000 to rewind five seconds."),
        device,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool(() =>
        seekPlayback({
          positionMs: args.position_ms,
          offsetMs: args.offset_ms,
          device: args.device,
        }),
      ),
  );

  server.registerTool(
    "set_volume",
    {
      title: "Set volume",
      description:
        "Set the playback volume: percent sets an absolute level 0-100, delta adjusts by a signed amount. Provide exactly one.",
      inputSchema: {
        percent: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Absolute volume level, 0-100."),
        delta: z
          .number()
          .int()
          .optional()
          .describe("Signed volume change, e.g. -10 to lower by ten points."),
        device,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool(() =>
        setVolume({ percent: args.percent, delta: args.delta, device: args.device }),
      ),
  );

  server.registerTool(
    "set_playback_mode",
    {
      title: "Set playback mode",
      description: "Set shuffle and/or repeat. Provide at least one of shuffle or repeat.",
      inputSchema: {
        shuffle: z.boolean().optional(),
        repeat: z.enum(["off", "context", "track"]).optional(),
        device,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      runTool(async () => {
        if (args.shuffle === undefined && args.repeat === undefined) {
          throw usageError("Provide at least one of shuffle or repeat.");
        }
        const data: Record<string, unknown> = {};
        const messages: string[] = [];
        if (args.shuffle !== undefined) {
          const result = await setShuffle(args.shuffle, { device: args.device });
          data["shuffle"] = result.data;
          messages.push(result.message);
        }
        if (args.repeat !== undefined) {
          const result = await setRepeat(args.repeat, { device: args.device });
          data["repeat"] = result.data;
          messages.push(result.message);
        }
        return { data, message: messages.join(" ") };
      }),
  );

  server.registerTool(
    "queue_list",
    {
      title: "List queue",
      description: "Show the currently playing item and the upcoming queue.",
      inputSchema: {},
      outputSchema: {
        current: z
          .record(z.string(), z.unknown())
          .nullable()
          .describe("The item playing now, or null when nothing is playing."),
        items: z.array(queueItemShape).describe("Upcoming items in order."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => runTool(() => queueList()),
  );

  server.registerTool(
    "queue_add",
    {
      title: "Add to queue",
      description: "Append tracks or episodes to the playback queue.",
      inputSchema: {
        uris: z
          .array(z.string())
          .min(1)
          .describe("Spotify track or episode URIs or open.spotify.com URLs."),
        device,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => queueAdd(args.uris, { device: args.device })),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List devices",
      description: "List the available Spotify Connect devices.",
      inputSchema: {},
      outputSchema: { devices: z.array(deviceShape) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () =>
      runTool(async () => {
        const result = await deviceList();
        return { data: { devices: result.data }, message: result.message };
      }),
  );

  server.registerTool(
    "transfer_playback",
    {
      title: "Transfer playback",
      description: "Transfer playback to another Spotify Connect device.",
      inputSchema: {
        device: z
          .string()
          .describe("Target device, by ID or name from list_devices."),
        play: z
          .boolean()
          .optional()
          .describe("Start playing after the transfer. Defaults to true."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => deviceTransfer(args.device, args.play ?? true)),
  );
}
