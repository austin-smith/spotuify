import type { Command } from "commander";
import type { PlaylistDetails } from "../api/playlists.ts";
import { artistLine, type Device, type PlayableItem } from "../api/types.ts";
import { unavailable, usageError } from "./errors.ts";
import {
  CliOutput,
  formatDuration,
  type CliIo,
  type GlobalOutputOptions,
} from "./output.ts";
import { cliSession } from "./session.ts";
import { spotifyReference } from "./values.ts";

export interface RunState {
  exitCode: number;
}

export function enumValue<T extends string>(
  values: readonly T[],
  label: string,
) {
  return (value: string): T => {
    if (!values.includes(value as T))
      throw usageError(`Invalid ${label}: ${value}.`);
    return value as T;
  };
}

export function outputFor(command: Command, io: CliIo): CliOutput {
  return new CliOutput(command.optsWithGlobals() as GlobalOutputOptions, io);
}

export function table(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  if (rows.length === 0) return "No results.";
  const textRows = rows.map((row) =>
    row.map((cell) =>
      cell === null || cell === undefined ? "" : String(cell),
    ),
  );
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...textRows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...textRows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function itemRows(items: PlayableItem[]): (string | number | null)[][] {
  return items.map((item, index) => [
    index + 1,
    item.name,
    artistLine(item),
    formatDuration(item.duration_ms),
    item.uri,
  ]);
}

export function uniqueDevice(devices: Device[], selector: string): Device {
  const byId = devices.find((device) => device.id === selector);
  if (byId !== undefined) return byId;
  const matches = devices.filter(
    (device) => device.name.toLowerCase() === selector.toLowerCase(),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw usageError(
      `More than one device is named ${selector}. Use its ID instead.`,
    );
  throw unavailable(
    `Spotify device not found: ${selector}`,
    "Run `spotuify device list` to see available devices.",
  );
}

export async function selectedDevice(
  selector: string,
): Promise<Device & { id: string }> {
  const { player } = await cliSession();
  return targetDevice(await player.devices(), selector);
}

export function targetDevice(
  devices: Device[],
  selector: string,
): Device & { id: string } {
  const target = uniqueDevice(devices, selector);
  if (target.id === null) {
    throw unavailable(
      `Device ${target.name} has no usable ID.`,
      "Choose another device from `spotuify device list`.",
    );
  }
  if (target.is_restricted) {
    throw unavailable(`Device ${target.name} cannot receive playback commands.`);
  }
  return target as Device & { id: string };
}

export function mutation(
  command: Command,
  io: CliIo,
  name: string,
  data: Record<string, unknown>,
  message: string,
): void {
  outputFor(command, io).emit(
    name,
    { ok: true, ...data },
    message,
    "success",
  );
}

export function runtimePlaybackText(value: unknown): string {
  if (value === null || typeof value !== "object")
    return "Spotuify runtime is active.";
  const state = value as Record<string, unknown>;
  const item = state["item"];
  if (item === null || typeof item !== "object") return "Nothing is playing.";
  const playable = item as Record<string, unknown>;
  const status = state["isPlaying"] === true ? "Playing" : "Paused";
  const device = state["device"];
  const deviceName =
    device !== null && typeof device === "object"
      ? (device as Record<string, unknown>)["name"]
      : null;
  return `${status}  ${String(playable["name"] ?? "Unknown")} — ${String(playable["artist"] ?? "")}\n${formatDuration(typeof state["progressMs"] === "number" ? state["progressMs"] : null)} / ${formatDuration(typeof state["durationMs"] === "number" ? state["durationMs"] : null)} · ${String(state["repeat"] ?? "off")}${state["shuffle"] === true ? " · shuffle" : ""}${typeof deviceName === "string" ? ` · ${deviceName}` : ""}`;
}

export function runtimeNumber(value: unknown, field: string): number | null {
  if (value === null || typeof value !== "object") return null;
  const selected = (value as Record<string, unknown>)[field];
  return typeof selected === "number" ? selected : null;
}

export function runtimeBoolean(value: unknown, field: string): boolean | null {
  if (value === null || typeof value !== "object") return null;
  const selected = (value as Record<string, unknown>)[field];
  return typeof selected === "boolean" ? selected : null;
}

export function wait(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function currentState() {
  const { player } = await cliSession();
  return await player.state("foreground");
}

export function playlistId(value: string): string {
  return spotifyReference(value, "playlist").id;
}

export function normalizePlaylistDetails(
  details: PlaylistDetails,
): Record<string, unknown> {
  return {
    id: details.id,
    uri: details.uri,
    name: details.name,
    description: details.description,
    public: details.public,
    collaborative: details.collaborative,
    owner: details.ownerName,
    followers: details.followers,
    totalItems: details.totalItems,
  };
}

/** The shared heading for `show <playlist>` and `playlist show`. */
export function playlistHeader(details: PlaylistDetails): string {
  const visibility =
    details.public === null ? null : details.public ? "public" : "private";
  const facts = [
    details.ownerName === "" ? null : `by ${details.ownerName}`,
    details.totalItems === null
      ? null
      : `${details.totalItems} item${details.totalItems === 1 ? "" : "s"}`,
    visibility,
    details.collaborative ? "collaborative" : null,
  ].filter((fact): fact is string => fact !== null);
  return [
    `${details.name}${facts.length > 0 ? ` — ${facts.join(" · ")}` : ""}`,
    ...(details.description === null ? [] : [details.description]),
    details.uri,
  ].join("\n");
}
