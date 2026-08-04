import {
  artistLine,
  isTrack,
  type Episode,
  type FullArtist,
  type PlayableItem,
  type PlaybackState,
  type SimpleAudiobook,
  type SimpleShow,
} from "../api/types.ts";
import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { CliError, usageError } from "./errors.ts";
import {
  CliPresenter,
  type HumanPresentation,
} from "./presenter.ts";

export type OutputMode = "auto" | "human" | "plain" | "json" | "jsonl";

type TtyWritable = Writable & { isTTY?: boolean };

export interface GlobalOutputOptions {
  output?: OutputMode;
  json?: boolean;
  plain?: boolean;
  quiet?: boolean;
  field?: string;
  template?: string;
}

export interface CliIo {
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}

function snakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function machineValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(machineValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [snakeCaseKey(key), machineValue(item)]),
    );
  }
  return value;
}

function pathValue(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function renderTemplate(template: string, data: unknown): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, path: string) =>
    scalar(pathValue(data, path)),
  );
}

function terminalSafe(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g,
    "",
  );
}

export class CliOutput {
  readonly mode: Exclude<OutputMode, "auto">;
  readonly quiet: boolean;
  readonly field?: string;
  readonly template?: string;
  readonly presenter: CliPresenter;

  constructor(
    options: GlobalOutputOptions,
    readonly io: CliIo,
    presenter?: CliPresenter,
  ) {
    this.presenter =
      presenter ??
      new CliPresenter({
        stdout: io.stdout,
        stderr: io.stderr,
        env: io.env,
      });
    const explicit = [
      options.json === true,
      options.plain === true,
      options.output !== undefined,
    ].filter(Boolean).length;
    if (explicit > 1)
      throw usageError("Choose only one of --output, --json, or --plain.");
    this.mode =
      options.json === true
        ? "json"
        : options.plain === true
          ? "plain"
          : options.output === undefined || options.output === "auto"
            ? (io.stdout as TtyWritable).isTTY === true
              ? "human"
              : "plain"
            : options.output;
    this.quiet = options.quiet === true;
    this.field = options.field;
    this.template = options.template;
    if (
      (this.field !== undefined || this.template !== undefined) &&
      !["plain", "human"].includes(this.mode)
    ) {
      throw usageError(
        "--field and --template cannot be combined with JSON output.",
      );
    }
  }

  emit(
    command: string,
    value: unknown,
    human: string,
    presentation: HumanPresentation = "detail",
  ): void {
    if (this.quiet) return;
    const data = machineValue(value);
    if (this.field !== undefined) {
      const selected = pathValue(data, this.field);
      this.io.stdout.write(`${terminalSafe(scalar(selected))}\n`);
      return;
    }
    if (this.template !== undefined) {
      this.io.stdout.write(
        `${terminalSafe(renderTemplate(this.template, data))}\n`,
      );
      return;
    }
    if (this.mode === "json" || this.mode === "jsonl") {
      this.io.stdout.write(
        `${JSON.stringify({ schema_version: 1, command, data })}\n`,
      );
      return;
    }
    const safeHuman = terminalSafe(human);
    if (this.mode === "human" && presentation !== "stream") {
      this.presenter.showResult(command, safeHuman, presentation);
      return;
    }
    this.io.stdout.write(
      safeHuman.endsWith("\n") ? safeHuman : `${safeHuman}\n`,
    );
  }

  error(error: CliError): void {
    if (this.mode === "json" || this.mode === "jsonl") {
      this.io.stderr.write(
        `${JSON.stringify({
          schema_version: 1,
          error: { code: error.code, message: error.message, hint: error.hint },
        })}\n`,
      );
      return;
    }
    const message = terminalSafe(error.message);
    const hint =
      error.hint === undefined ? undefined : terminalSafe(error.hint);
    if (this.mode === "human") {
      this.presenter.showCommandError(message, hint);
      return;
    }
    this.io.stderr.write(`Error: ${message}\n`);
    if (hint !== undefined) this.io.stderr.write(`Hint: ${hint}\n`);
  }
}

export function normalizeItem(
  item: PlayableItem | null,
): Record<string, unknown> | null {
  if (item === null) return null;
  return {
    type: isTrack(item) ? "track" : "episode",
    id: item.id,
    uri: item.uri,
    name: item.name,
    artists: isTrack(item) ? item.artists.map((artist) => artist.name) : [],
    artist: artistLine(item),
    album: isTrack(item) ? item.album.name : null,
    show: isTrack(item) ? null : (item.show?.name ?? null),
    durationMs: item.duration_ms,
  };
}

export function normalizeEpisode(episode: Episode): Record<string, unknown> {
  return normalizeItem(episode) ?? {};
}

export function normalizeShow(show: SimpleShow): Record<string, unknown> {
  return {
    type: "show",
    id: show.id,
    uri: show.uri,
    name: show.name,
    publisher: show.publisher ?? null,
    description: show.description ?? null,
    totalEpisodes: show.total_episodes ?? null,
  };
}

export function normalizeAudiobook(
  audiobook: SimpleAudiobook,
): Record<string, unknown> {
  return {
    type: "audiobook",
    id: audiobook.id,
    uri: audiobook.uri,
    name: audiobook.name,
    authors: (audiobook.authors ?? []).map((author) => author.name),
    publisher: audiobook.publisher ?? null,
    totalChapters: audiobook.total_chapters ?? null,
  };
}

export function normalizeArtist(artist: FullArtist): Record<string, unknown> {
  return {
    type: "artist",
    id: artist.id,
    uri: artist.uri,
    name: artist.name,
    genres: artist.genres ?? [],
    followers: artist.followers?.total ?? null,
  };
}

export function normalizePlayback(
  state: PlaybackState | null,
): Record<string, unknown> {
  return {
    active: state !== null,
    isPlaying: state?.is_playing ?? false,
    item: normalizeItem(state?.item ?? null),
    progressMs: state?.progress_ms ?? null,
    durationMs: state?.item?.duration_ms ?? null,
    shuffle: state?.shuffle_state ?? false,
    repeat: state?.repeat_state ?? "off",
    contextUri: state?.context?.uri ?? null,
    device:
      state?.device === null || state?.device === undefined
        ? null
        : {
            id: state.device.id,
            name: state.device.name,
            type: state.device.type,
            volumePercent: state.device.volume_percent,
            isRestricted: state.device.is_restricted,
          },
  };
}

export function normalizeRuntimePlayback(value: unknown): Record<string, unknown> {
  const state =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const device =
    state["device"] !== null && typeof state["device"] === "object"
      ? (state["device"] as Record<string, unknown>)
      : null;
  return {
    active: state["active"] === true,
    isPlaying: state["isPlaying"] === true,
    item:
      state["item"] !== null && typeof state["item"] === "object"
        ? state["item"]
        : null,
    progressMs:
      typeof state["progressMs"] === "number" ? state["progressMs"] : null,
    durationMs:
      typeof state["durationMs"] === "number" ? state["durationMs"] : null,
    shuffle: state["shuffle"] === true,
    repeat:
      state["repeat"] === "track" || state["repeat"] === "context"
        ? state["repeat"]
        : "off",
    contextUri:
      typeof state["contextUri"] === "string" ? state["contextUri"] : null,
    device:
      device === null
        ? null
        : {
            id: typeof device["id"] === "string" ? device["id"] : null,
            name:
              typeof device["name"] === "string" ? device["name"] : "Unknown",
            type: typeof device["type"] === "string" ? device["type"] : null,
            volumePercent:
              typeof device["volumePercent"] === "number"
                ? device["volumePercent"]
                : null,
            isRestricted:
              typeof device["isRestricted"] === "boolean"
                ? device["isRestricted"]
                : null,
          },
  };
}

export function formatDuration(
  milliseconds: number | null | undefined,
): string {
  if (milliseconds === null || milliseconds === undefined) return "--:--";
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function playbackText(state: PlaybackState | null): string {
  if (state === null || state.item === null) return "Nothing is playing.";
  const status = state.is_playing ? "Playing" : "Paused";
  const device =
    state.device?.name === undefined ? "" : ` · ${state.device.name}`;
  return `${status}  ${state.item.name} — ${artistLine(state.item)}\n${formatDuration(state.progress_ms)} / ${formatDuration(state.item.duration_ms)} · ${state.repeat_state}${state.shuffle_state ? " · shuffle" : ""}${device}`;
}
