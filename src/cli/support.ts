import type { Command } from "commander";
import type { PlaylistDetails } from "../api/playlists.ts";
import { artistLine, type Device, type PlayableItem } from "../api/types.ts";
import { tryRuntimeRequest } from "../runtime/control.ts";
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

function runtimeDeviceList(
  value: unknown,
): { devices: Device[]; localDeviceId: string | null } {
  const record =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const devices = Array.isArray(record["devices"])
    ? (record["devices"] as unknown[]).filter(
        (device): device is Device =>
          device !== null &&
          typeof device === "object" &&
          typeof (device as Device).name === "string",
      )
    : [];
  const local = record["localDeviceId"];
  return {
    devices,
    localDeviceId: typeof local === "string" ? local : null,
  };
}

/**
 * Every targetable device.
 *
 * A connected runtime is the authority: its list merges Spotify's remote devices with the embedded
 * receiver, which `/me/player/devices` does not always include. Without a runtime the Web API list
 * is all there is.
 */
export async function allDevices(): Promise<Device[]> {
  const probe = await tryRuntimeRequest("device.list");
  if (probe.connected) return runtimeDeviceList(probe.value).devices;
  const { player } = await cliSession();
  return await player.devices();
}

export async function selectedDevice(
  selector: string,
): Promise<Device & { id: string }> {
  return targetDevice(await allDevices(), selector);
}

export type DeviceTarget =
  | { route: "web"; device: Device & { id: string } }
  | { route: "local"; id: string; name: string; active: boolean };

/**
 * Resolve a `--device` selector for a playback command.
 *
 * The account-matched embedded receiver must route through its runtime: a Web API command aimed at
 * our own receiver would bypass the serialized native mutation stream and can miss the receiver
 * entirely when Spotify omits it from the device list. Every other device is a Web API target.
 */
export async function resolveDeviceTarget(
  selector: string,
): Promise<DeviceTarget> {
  const probe = await tryRuntimeRequest("device.list");
  if (!probe.connected) {
    const { player } = await cliSession();
    return {
      route: "web",
      device: targetDevice(await player.devices(), selector),
    };
  }
  const { devices, localDeviceId } = runtimeDeviceList(probe.value);
  const device = targetDevice(devices, selector);
  if (localDeviceId !== null && device.id === localDeviceId) {
    return {
      route: "local",
      id: device.id,
      name: device.name,
      active: device.is_active === true,
    };
  }
  return { route: "web", device };
}

/** The refusal for state commands aimed at an idle receiver, where the Web API would 404 anyway. */
export function inactiveReceiver(name: string): never {
  throw unavailable(
    `${name} is not the active device.`,
    `Transfer playback first: \`spotuify device transfer ${name}\`.`,
  );
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
