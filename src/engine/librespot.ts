import { dirname, resolve } from "node:path";
import { DEVICE_NAME, LIBRESPOT_CACHE_DIR } from "../config.ts";

declare const SPOTUIFY_STANDALONE: boolean | undefined;

const COMMAND_TIMEOUT_MS = 10_000;
const ENGINE_READINESS_TIMEOUT_MS = 30_000;
const STABLE_ENGINE_UPTIME_MS = 30_000;
const ENGINE_SHUTDOWN_GRACE_MS = 3_000;
const ENGINE_RESTART_DELAYS_MS = [1_000, 2_500, 5_000] as const;

/** A bounded reconnect policy: `null` means this run has exhausted its restart budget. */
export function engineRestartDelay(
  attempt: number,
  delays: readonly number[] = ENGINE_RESTART_DELAYS_MS,
): number | null {
  return delays[attempt] ?? null;
}

export interface SidecarLocationContext {
  platform?: NodeJS.Platform;
  configured?: string;
  standalone?: boolean;
  executablePath?: string;
}

export function isStandaloneBuild(): boolean {
  return typeof SPOTUIFY_STANDALONE !== "undefined" && SPOTUIFY_STANDALONE === true;
}

/**
 * Candidate sidecars ordered from explicit override, to packaged layouts, to source builds.
 *
 * Release archives keep both executables together. Homebrew installs the private sidecar in
 * `libexec`, adjacent to its `bin` directory. Source execution falls back to Cargo artifacts.
 */
export function sidecarCandidatePaths({
  platform = process.platform,
  configured = process.env["SPOTUIFY_ENGINE_PATH"],
  standalone = isStandaloneBuild(),
  executablePath = process.execPath,
}: SidecarLocationContext = {}): string[] {
  const executable = platform === "win32" ? "spotuify-engine.exe" : "spotuify-engine";
  const executableDirectory = dirname(resolve(executablePath));
  return [
    ...(configured && configured.length > 0 ? [resolve(configured)] : []),
    ...(standalone
      ? [
          resolve(executableDirectory, executable),
          resolve(executableDirectory, "../libexec", executable),
        ]
      : []),
    resolve(import.meta.dir, "../../native/target/debug", executable),
    resolve(import.meta.dir, "../../native/target/release", executable),
  ];
}

export function engineSetupCommand(standalone = isStandaloneBuild()): string {
  return standalone ? "spotuify auth" : "bun run auth";
}

export function missingEngineMessage(standalone = isStandaloneBuild()): string {
  return standalone
    ? "The packaged playback engine is missing. Reinstall spotuify and run `spotuify auth` again."
    : "Run `bun run engine:build`, then re-run `bun run auth`.";
}

export function missingEngineHint(standalone = isStandaloneBuild()): string {
  return standalone ? "reinstall spotuify" : "run: bun run engine:build";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type EngineAuthenticationResult = "authorized" | "missing" | "failed" | "timed-out";

/**
 * Ask the native playback engine to run librespot's independent OAuth flow.
 *
 * Authentication runs before the renderer owns the terminal. The Web API token never crosses this
 * process boundary; the engine owns its own OAuth token, reusable credentials, and cache security.
 */
export async function authenticateEngine(
  options: { force?: boolean; sidecarPath?: string } = {},
  timeoutMs = 180_000,
): Promise<EngineAuthenticationResult> {
  const binary =
    options.sidecarPath !== undefined
      ? resolve(options.sidecarPath)
      : await LibrespotEngine.locateSidecar();
  if (binary === null) return "missing";

  const proc = Bun.spawn([binary, "auth"], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  proc.stdin.write(
    `${JSON.stringify({
      cacheDir: LIBRESPOT_CACHE_DIR,
      deviceName: DEVICE_NAME,
      force: options.force === true,
    })}\n`,
  );
  await proc.stdin.end();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const code = await proc.exited;
    if (timedOut) return "timed-out";
    return code === 0 ? "authorized" : "failed";
  } finally {
    clearTimeout(timeout);
  }
}

export type EngineStatus =
  | { state: "disabled" }
  | { state: "missing" }
  | { state: "starting" }
  | { state: "ready"; pid: number; deviceId: string; accountId: string }
  | { state: "failed"; reason: string };

export interface NativeArtist {
  id: string;
  name: string;
  uri: string;
}

export interface NativeCover {
  url: string;
  width: number;
  height: number;
}

export type EngineEvent =
  | {
      name: "track_changed";
      media_type: "track" | "episode" | "local";
      id?: string;
      uri: string;
      title: string;
      duration_ms: number;
      artists: NativeArtist[];
      album?: string;
      show?: string;
      covers: NativeCover[];
    }
  | {
      name: "playing" | "paused" | "seeked" | "position_changed";
      uri: string;
      position_ms: number;
    }
  | { name: "stopped" | "end_of_track"; uri: string }
  | { name: "volume_changed"; percent: number }
  | { name: "session_connected" | "session_disconnected" }
  | { name: "shuffle_changed"; enabled: boolean }
  | { name: "repeat_changed"; context: boolean; track: boolean };

export interface ResolvedTrackMetadata {
  kind: "track_metadata";
  album: {
    id: string;
    name: string;
    uri: string;
  };
}

interface PlayUnavailable {
  kind: "play_unavailable";
  reason: string;
}

type EngineResponseData = ResolvedTrackMetadata | PlayUnavailable;

export class NativePlaybackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativePlaybackUnavailableError";
  }
}

export type EngineMessage =
  | {
      type: "status";
      state: "ready" | "failed" | "protocol_error";
      device_id?: string;
      account_id?: string;
      reason?: string;
    }
  | {
      type: "response";
      id: number;
      ok: boolean;
      error?: string;
      data?: EngineResponseData;
    }
  | { type: "event"; event: EngineEvent };

type EngineCommand =
  | { command: "activate" }
  | { command: "transfer" }
  | { command: "play" }
  | { command: "pause" }
  | { command: "next" }
  | { command: "previous" }
  | { command: "seek"; position_ms: number }
  | { command: "volume"; percent: number }
  | { command: "shuffle"; enabled: boolean }
  | { command: "repeat"; mode: "off" | "context" | "track" }
  | { command: "resolve_track"; uri: string }
  | {
      command: "load";
      context_uri?: string;
      uris?: string[];
      offset?: number;
      shuffle: boolean;
      repeat: "off" | "context" | "track";
    }
  | { command: "shutdown" };

interface PendingCommand {
  resolve: (data: EngineResponseData | undefined) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface LibrespotEngineOptions {
  /** Explicit process path used by integration tests and packaged launchers. */
  sidecarPath?: string;
  restartDelaysMs?: readonly number[];
  stableUptimeMs?: number;
  readinessTimeoutMs?: number;
}

/**
 * Supervises Spotuify's structured librespot sidecar.
 *
 * Stdout is a JSON-lines protocol for readiness, command acknowledgments and player events.
 * Librespot credentials remain in its own cache and never cross this boundary.
 */
export class LibrespotEngine {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private stopped = false;
  private lifecycle = 0;
  private reachedReady = false;
  private active = false;
  private restartAttempt = 0;
  /** The current child reported a structured startup failure that may recover on a fresh session. */
  private coldRestartEligible = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private status: EngineStatus = { state: "starting" };
  private nextCommandId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  /** Stateful Spirc commands are sent one at a time; metadata commands remain independently concurrent. */
  private orderedCommandTail: Promise<void> = Promise.resolve();
  private readonly resolvedTracks = new Map<string, Promise<ResolvedTrackMetadata>>();
  private readonly statusListeners = new Set<(status: EngineStatus) => void>();
  private readonly eventListeners = new Set<(event: EngineEvent) => void>();
  /** Events cannot be trusted by account-bound consumers until ready publishes canonical identity. */
  private readonly eventBacklog: EngineEvent[] = [];

  constructor(
    private readonly deviceName: string = DEVICE_NAME,
    private readonly options: LibrespotEngineOptions = {},
  ) {}

  /** Absolute path to the native sidecar built from `native/Cargo.toml`. */
  static async locateSidecar(): Promise<string | null> {
    for (const candidate of sidecarCandidatePaths()) {
      if (await Bun.file(candidate).exists()) return candidate;
    }
    return null;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /** Whether librespot has authoritatively joined the active Spotify Connect session. */
  isActive(): boolean {
    return this.status.state === "ready" && this.active;
  }

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.flushEventBacklog();
    return () => this.eventListeners.delete(listener);
  }

  private setStatus(status: EngineStatus): void {
    // Leaving `ready` invalidates an active Connect session. Publish that loss while the last
    // verified account and device identity are still available, so account-bound consumers can
    // authenticate and apply the disconnect. The process-exit fallback sees `active === false` and
    // therefore cannot emit a duplicate.
    if (this.status.state === "ready" && status.state !== "ready" && this.active) {
      this.active = false;
      this.emitEvent({ name: "session_disconnected" });
    }
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  async start(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.stopped = false;
    this.reachedReady = false;
    this.active = false;
    this.restartAttempt = 0;
    this.coldRestartEligible = false;
    this.clearLifecycleTimers();

    try {
      const binary =
        this.options.sidecarPath !== undefined
          ? resolve(this.options.sidecarPath)
          : await LibrespotEngine.locateSidecar();
      if (!this.isCurrent(lifecycle)) return;
      if (binary === null) {
        this.setStatus({ state: "missing" });
        return;
      }
      this.spawn(binary, lifecycle);
    } catch (error) {
      if (!this.isCurrent(lifecycle)) return;
      this.setStatus({
        state: "failed",
        reason: `playback engine setup failed: ${errorMessage(error)}`,
      });
    }
  }

  async transfer(): Promise<void> {
    await this.command({ command: "transfer" });
  }

  async activate(): Promise<void> {
    await this.command({ command: "activate" });
  }

  async play(): Promise<void> {
    const data = await this.command({ command: "play" });
    if (data?.kind === "play_unavailable") {
      throw new NativePlaybackUnavailableError(data.reason);
    }
  }

  async pause(): Promise<void> {
    await this.command({ command: "pause" });
  }

  async next(): Promise<void> {
    await this.command({ command: "next" });
  }

  async previous(): Promise<void> {
    await this.command({ command: "previous" });
  }

  async seek(positionMs: number): Promise<void> {
    await this.command({ command: "seek", position_ms: Math.max(0, Math.round(positionMs)) });
  }

  async setVolume(percent: number): Promise<void> {
    await this.command({
      command: "volume",
      percent: Math.min(100, Math.max(0, Math.round(percent))),
    });
  }

  async setShuffle(enabled: boolean): Promise<void> {
    await this.command({ command: "shuffle", enabled });
  }

  async setRepeat(mode: "off" | "context" | "track"): Promise<void> {
    await this.command({ command: "repeat", mode });
  }

  /** Resolve metadata that librespot's playback event intentionally omits, cached by track URI. */
  async resolveTrack(uri: string): Promise<ResolvedTrackMetadata> {
    const existing = this.resolvedTracks.get(uri);
    if (existing !== undefined) return await existing;

    const pending = (async () => {
      const data = await this.command({ command: "resolve_track", uri });
      if (data?.kind !== "track_metadata") {
        throw new Error("playback engine returned no track metadata");
      }
      return data;
    })();
    this.resolvedTracks.set(uri, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.resolvedTracks.get(uri) === pending) this.resolvedTracks.delete(uri);
      throw error;
    }
  }

  async load(options: {
    contextUri?: string;
    uris?: string[];
    offset?: number;
    shuffle: boolean;
    repeat: "off" | "context" | "track";
  }): Promise<void> {
    await this.command({
      command: "load",
      ...(options.contextUri !== undefined ? { context_uri: options.contextUri } : {}),
      ...(options.uris !== undefined ? { uris: options.uris } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      shuffle: options.shuffle,
      repeat: options.repeat,
    });
  }

  private spawn(binary: string, lifecycle: number): void {
    if (!this.isCurrent(lifecycle)) return;
    this.setStatus({ state: "starting" });
    this.active = false;
    this.coldRestartEligible = false;
    this.eventBacklog.length = 0;

    let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
    try {
      proc = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
      this.proc = proc;
      proc.stdin.write(
        `${JSON.stringify({ cacheDir: LIBRESPOT_CACHE_DIR, deviceName: this.deviceName })}\n`,
      );
      proc.stdin.flush();
    } catch (error) {
      if (proc !== null) {
        if (this.proc === proc) this.proc = null;
        proc.kill();
      }
      this.handleLaunchFailure(binary, lifecycle, error);
      return;
    }

    let lastError = "";
    let readinessTimedOut = false;
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    this.readinessTimer = setTimeout(() => {
      if (!this.isCurrent(lifecycle) || this.proc !== proc || this.status.state !== "starting") {
        return;
      }
      readinessTimedOut = true;
      this.readinessTimer = null;
      this.setStatus({
        state: "failed",
        reason: "playback engine timed out while connecting to Spotify",
      });
      proc.kill();
    }, this.options.readinessTimeoutMs ?? ENGINE_READINESS_TIMEOUT_MS);

    void consumeLines(proc.stderr, (line) => {
      // Keep bounded, credential-free failure context. The sidecar reserves stdout for protocol
      // data and emits no token contents.
      if (line.length > 0) lastError = line;
    });
    void consumeLines(proc.stdout, (line) => this.receive(line, proc, lifecycle));

    void (async () => {
      const code = await proc.exited;
      if (this.proc === proc) this.proc = null;
      this.rejectPending(new Error(`playback engine exited with code ${code}`));
      if (!this.isCurrent(lifecycle)) return;
      if (this.stableTimer !== null) clearTimeout(this.stableTimer);
      if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
      this.stableTimer = null;
      this.readinessTimer = null;

      // A vanished active receiver is an authoritative disconnect even if the child died before it
      // could serialize librespot's final event. Do not emit this for an idle/available receiver,
      // because that would erase playback belonging to another device.
      if (this.active) {
        this.active = false;
        this.emitEvent({ name: "session_disconnected" });
      }

      const reason =
        this.status.state === "failed"
          ? this.status.reason
          : lastError.length > 0
            ? lastError
            : `playback engine exited with code ${code}`;
      this.scheduleRestart(
        binary,
        lifecycle,
        reason,
        readinessTimedOut || this.coldRestartEligible,
      );
    })();
  }

  private handleLaunchFailure(binary: string, lifecycle: number, error: unknown): void {
    if (!this.isCurrent(lifecycle)) return;
    const reason = `could not launch playback engine: ${errorMessage(error)}`;
    if (this.reachedReady) {
      this.scheduleRestart(binary, lifecycle, reason);
    } else {
      this.setStatus({ state: "failed", reason });
    }
  }

  private receive(line: string, proc: Bun.Subprocess, lifecycle: number): void {
    if (!this.isCurrent(lifecycle) || this.proc !== proc) return;
    const message = parseEngineMessage(line);
    if (message === null) {
      this.setStatus({ state: "failed", reason: "playback engine sent invalid protocol data" });
      proc.kill();
      return;
    }

    switch (message.type) {
      case "status":
        if (message.state === "ready" && this.status.state !== "starting") {
          // A child that answered after its readiness deadline is already being terminated. Never
          // resurrect it briefly or flush events from a lifecycle the supervisor has rejected.
          proc.kill();
          break;
        }
        if (
          message.state === "ready" &&
          message.device_id !== undefined &&
          message.account_id !== undefined
        ) {
          if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
          this.readinessTimer = null;
          this.reachedReady = true;
          this.setStatus({
            state: "ready",
            pid: proc.pid,
            deviceId: message.device_id,
            accountId: message.account_id,
          });
          this.flushEventBacklog();
          if (this.stableTimer !== null) clearTimeout(this.stableTimer);
          this.stableTimer = setTimeout(() => {
            if (this.isCurrent(lifecycle) && this.proc === proc && this.status.state === "ready") {
              this.restartAttempt = 0;
            }
          }, this.options.stableUptimeMs ?? STABLE_ENGINE_UPTIME_MS);
        } else {
          if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
          this.readinessTimer = null;
          // A well-formed failure from a launched sidecar can be a transient Spotify/network
          // connection failure. Give it the same bounded cold-start budget as a readiness timeout.
          // Launch failures and invalid protocol data remain terminal before first readiness.
          if (!this.reachedReady && message.state === "failed") {
            this.coldRestartEligible = true;
          }
          this.setStatus({
            state: "failed",
            reason:
              message.reason ??
              (message.state === "protocol_error"
                ? "playback engine protocol failed"
                : "Spotify Connect session failed"),
          });
          proc.kill();
        }
        break;
      case "response": {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new Error(message.error ?? "playback engine command failed"));
        break;
      }
      case "event":
        if (message.event.name === "session_connected") this.active = true;
        else if (message.event.name === "session_disconnected") this.active = false;
        if (this.status.state === "ready" && this.eventListeners.size > 0) {
          this.emitEvent(message.event);
        } else {
          this.bufferEvent(message.event);
        }
        break;
    }
  }

  private emitEvent(event: EngineEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private flushEventBacklog(): void {
    if (this.status.state !== "ready" || this.eventListeners.size === 0) return;
    const events = this.eventBacklog.splice(0);
    for (const event of events) this.emitEvent(event);
  }

  /** Retain a bounded latest-state replay rather than accumulating one position event per second. */
  private bufferEvent(event: EngineEvent): void {
    const isPlayback = (candidate: EngineEvent): boolean =>
      candidate.name === "playing" ||
      candidate.name === "paused" ||
      candidate.name === "stopped" ||
      candidate.name === "end_of_track";
    const isPosition = (candidate: EngineEvent): boolean =>
      candidate.name === "seeked" || candidate.name === "position_changed";
    const removeWhere = (predicate: (candidate: EngineEvent) => boolean): void => {
      for (let index = this.eventBacklog.length - 1; index >= 0; index--) {
        const candidate = this.eventBacklog[index];
        if (candidate !== undefined && predicate(candidate)) this.eventBacklog.splice(index, 1);
      }
    };

    switch (event.name) {
      case "session_disconnected":
        removeWhere(
          (candidate) =>
            candidate.name === "session_connected" ||
            candidate.name === "session_disconnected" ||
            candidate.name === "track_changed" ||
            isPlayback(candidate) ||
            isPosition(candidate),
        );
        break;
      case "session_connected":
        removeWhere(
          (candidate) =>
            candidate.name === "session_connected" || candidate.name === "session_disconnected",
        );
        break;
      case "track_changed":
        removeWhere(
          (candidate) =>
            candidate.name === "track_changed" ||
            isPlayback(candidate) ||
            isPosition(candidate),
        );
        break;
      case "playing":
      case "paused":
      case "end_of_track":
        removeWhere(isPlayback);
        break;
      case "stopped":
        removeWhere((candidate) => isPlayback(candidate) || isPosition(candidate));
        break;
      case "seeked":
      case "position_changed":
        removeWhere(isPosition);
        break;
      case "volume_changed":
      case "shuffle_changed":
      case "repeat_changed":
        removeWhere((candidate) => candidate.name === event.name);
        break;
    }
    this.eventBacklog.push(event);
  }

  private scheduleRestart(
    binary: string,
    lifecycle: number,
    reason: string,
    allowColdRestart = false,
  ): void {
    const delay = this.reachedReady || allowColdRestart
      ? engineRestartDelay(this.restartAttempt, this.options.restartDelaysMs)
      : null;
    if (delay === null) {
      this.setStatus({ state: "failed", reason });
      return;
    }

    this.restartAttempt++;
    this.setStatus({
      state: "failed",
      reason: `${reason} — reconnecting in ${(delay / 1_000).toLocaleString()}s`,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawn(binary, lifecycle);
    }, delay);
  }

  private clearLifecycleTimers(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    if (this.readinessTimer !== null) clearTimeout(this.readinessTimer);
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.restartTimer = null;
    this.readinessTimer = null;
    this.stableTimer = null;
  }

  private isCurrent(lifecycle: number): boolean {
    return !this.stopped && lifecycle === this.lifecycle;
  }

  private command(command: EngineCommand): Promise<EngineResponseData | undefined> {
    const proc = this.proc;
    if (proc === null || this.status.state !== "ready") {
      return Promise.reject(new Error("playback engine is not ready"));
    }

    const send = () => this.sendCommand(command, proc);
    if (command.command === "resolve_track") return send();

    const result = this.orderedCommandTail.then(send);
    this.orderedCommandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private sendCommand(
    command: EngineCommand,
    expectedProc: Bun.Subprocess<"pipe", "pipe", "pipe">,
  ): Promise<EngineResponseData | undefined> {
    if (this.proc !== expectedProc || this.status.state !== "ready") {
      return Promise.reject(new Error("playback engine changed before command dispatch"));
    }

    const id = this.nextCommandId++;
    return new Promise<EngineResponseData | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`playback engine did not acknowledge ${command.command}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        expectedProc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
        expectedProc.stdin.flush();
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  stop(): void {
    this.lifecycle++;
    this.stopped = true;
    this.clearLifecycleTimers();
    const proc = this.proc;
    this.proc = null;
    this.active = false;
    this.rejectPending(new Error("playback engine stopped"));
    if (proc === null) return;

    // Best-effort graceful shutdown, followed by a bounded local-process kill. No network work is
    // performed by this timeout.
    const id = this.nextCommandId++;
    try {
      proc.stdin.write(`${JSON.stringify({ id, command: "shutdown" })}\n`);
      proc.stdin.flush();
    } catch {
      // The child can exit between capture and write; shutdown remains complete in that case.
    } finally {
      const forceKillTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill();
      }, ENGINE_SHUTDOWN_GRACE_MS);
      // A clean sidecar exit must not leave the parent alive for the full forced-kill window.
      void proc.exited.finally(() => clearTimeout(forceKillTimer));
    }
  }
}

/** Parse and validate the sidecar trust boundary instead of casting arbitrary JSON. */
export function parseEngineMessage(line: string): EngineMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value["type"] !== "string") return null;

  switch (value["type"]) {
    case "status": {
      const state = value["state"];
      if (state !== "ready" && state !== "failed" && state !== "protocol_error") return null;
      if (
        !optionalString(value["device_id"]) ||
        !optionalString(value["account_id"]) ||
        !optionalString(value["reason"])
      ) {
        return null;
      }
      if (
        state === "ready" &&
        (typeof value["device_id"] !== "string" || typeof value["account_id"] !== "string")
      ) {
        return null;
      }
      return {
        type: "status",
        state,
        ...(typeof value["device_id"] === "string"
          ? { device_id: value["device_id"] }
          : {}),
        ...(typeof value["account_id"] === "string"
          ? { account_id: value["account_id"] }
          : {}),
        ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
      };
    }
    case "response": {
      const data =
        value["data"] === undefined ? undefined : parseEngineResponseData(value["data"]);
      if (
        !isUnsignedInteger(value["id"]) ||
        typeof value["ok"] !== "boolean" ||
        !optionalString(value["error"]) ||
        (value["data"] !== undefined && data === null)
      ) {
        return null;
      }
      return {
        type: "response",
        id: value["id"],
        ok: value["ok"],
        ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
        ...(data !== undefined && data !== null ? { data } : {}),
      };
    }
    case "event": {
      const event = parseEngineEvent(value["event"]);
      return event === null ? null : { type: "event", event };
    }
    default:
      return null;
  }
}

function parseEngineEvent(value: unknown): EngineEvent | null {
  if (!isRecord(value) || typeof value["name"] !== "string") return null;
  switch (value["name"]) {
    case "track_changed": {
      const mediaType = value["media_type"];
      if (
        (mediaType !== "track" && mediaType !== "episode" && mediaType !== "local") ||
        !optionalString(value["id"]) ||
        typeof value["uri"] !== "string" ||
        typeof value["title"] !== "string" ||
        !isUnsignedInteger(value["duration_ms"]) ||
        !isNativeArtistArray(value["artists"]) ||
        !isNativeCoverArray(value["covers"]) ||
        (value["album"] !== undefined &&
          value["album"] !== null &&
          typeof value["album"] !== "string") ||
        (value["show"] !== undefined &&
          value["show"] !== null &&
          typeof value["show"] !== "string")
      ) {
        return null;
      }
      return {
        name: "track_changed",
        media_type: mediaType,
        ...(typeof value["id"] === "string" ? { id: value["id"] } : {}),
        uri: value["uri"],
        title: value["title"],
        duration_ms: value["duration_ms"],
        artists: value["artists"],
        covers: value["covers"],
        ...(typeof value["album"] === "string" ? { album: value["album"] } : {}),
        ...(typeof value["show"] === "string" ? { show: value["show"] } : {}),
      };
    }
    case "playing":
    case "paused":
    case "seeked":
    case "position_changed":
      return typeof value["uri"] === "string" && isUnsignedInteger(value["position_ms"])
        ? { name: value["name"], uri: value["uri"], position_ms: value["position_ms"] }
        : null;
    case "stopped":
    case "end_of_track":
      return typeof value["uri"] === "string"
        ? { name: value["name"], uri: value["uri"] }
        : null;
    case "volume_changed":
      return isUnsignedInteger(value["percent"]) && value["percent"] <= 100
        ? { name: "volume_changed", percent: value["percent"] }
        : null;
    case "session_connected":
    case "session_disconnected":
      return { name: value["name"] };
    case "shuffle_changed":
      return typeof value["enabled"] === "boolean"
        ? { name: "shuffle_changed", enabled: value["enabled"] }
        : null;
    case "repeat_changed":
      return typeof value["context"] === "boolean" && typeof value["track"] === "boolean"
        ? {
            name: "repeat_changed",
            context: value["context"],
            track: value["track"],
          }
        : null;
    default:
      return null;
  }
}

function parseEngineResponseData(value: unknown): EngineResponseData | null {
  if (!isRecord(value)) return null;
  if (value["kind"] === "play_unavailable") {
    return typeof value["reason"] === "string"
      ? { kind: "play_unavailable", reason: value["reason"] }
      : null;
  }
  if (value["kind"] !== "track_metadata") return null;
  const album = value["album"];
  if (
    !isRecord(album) ||
    typeof album["id"] !== "string" ||
    typeof album["name"] !== "string" ||
    typeof album["uri"] !== "string"
  ) {
    return null;
  }
  return {
    kind: "track_metadata",
    album: {
      id: album["id"],
      name: album["name"],
      uri: album["uri"],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsignedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNativeCoverArray(value: unknown): value is NativeCover[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry["url"] === "string" &&
        isUnsignedInteger(entry["width"]) &&
        entry["width"] > 0 &&
        isUnsignedInteger(entry["height"]) &&
        entry["height"] > 0,
    )
  );
}

function isNativeArtistArray(value: unknown): value is NativeArtist[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry["id"] === "string" &&
        typeof entry["name"] === "string" &&
        typeof entry["uri"] === "string",
    )
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  receive: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) receive(line);
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode();
  const tail = buffered.trim();
  if (tail.length > 0) receive(tail);
}
