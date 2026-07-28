import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEVICE_NAME, LIBRESPOT_CACHE_DIR } from "../config.ts";

/** librespot writes its cached session credentials here. */
const CREDENTIALS_PATH = join(LIBRESPOT_CACHE_DIR, "credentials.json");

export async function hasEngineCredentials(): Promise<boolean> {
  return await Bun.file(CREDENTIALS_PATH).exists();
}

/**
 * Run librespot's own interactive OAuth once so it caches credentials.
 *
 * librespot has no login-and-exit mode: it authenticates and then runs as a device. So we let it
 * start with inherited stdio, wait for the credentials file to appear, then stop it. Requires a
 * TTY — call this from the CLI, never from inside the TUI.
 */
export async function authenticateEngine(timeoutMs = 180_000): Promise<boolean> {
  const binary = await LibrespotEngine.locate();
  if (binary === null) return false;
  if (await hasEngineCredentials()) return true;

  await mkdir(LIBRESPOT_CACHE_DIR, { recursive: true });
  console.log("\nlibrespot needs to sign in once to enable playback in the terminal.");

  const proc = Bun.spawn(
    [binary, "--name", DEVICE_NAME, "--cache", LIBRESPOT_CACHE_DIR, "--enable-oauth", "--disable-discovery"],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (await hasEngineCredentials()) {
        // librespot writes this 0644, but it is a reusable credential — restrict it to the owner.
        await chmod(CREDENTIALS_PATH, 0o600);
        return true;
      }
      // The process dying before credentials appear means the flow failed.
      if (proc.exitCode !== null) return false;
      await Bun.sleep(500);
    }
    return false;
  } finally {
    proc.kill();
  }
}

export type EngineStatus =
  | { state: "disabled" }
  | { state: "missing" }
  | { state: "starting" }
  | { state: "running"; pid: number }
  | { state: "failed"; reason: string };

/** Restart backoff, capped so a persistently broken engine doesn't spin. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * Supervises a `librespot` child process that registers as a Spotify Connect device.
 *
 * librespot handles its own OAuth (`--enable-oauth`) and caches credentials, so the Web API token
 * is never passed to it — Spotify's login5 does not reliably accept a third-party app's token.
 * The first run therefore needs a TTY, which is why `spotuify auth` sets it up before the TUI
 * takes the alternate screen.
 */
export class LibrespotEngine {
  private proc: Bun.Subprocess | null = null;
  private restarts = 0;
  private stopped = false;
  private status: EngineStatus = { state: "starting" };
  private listeners = new Set<(status: EngineStatus) => void>();

  constructor(private readonly deviceName: string = DEVICE_NAME) {}

  /** Absolute path to the librespot binary, or null when it isn't installed. */
  static async locate(): Promise<string | null> {
    const which = Bun.spawn(["which", "librespot"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(which.stdout).text()).trim();
    return (await which.exited) === 0 && out.length > 0 ? out : null;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /**
   * Start librespot and keep it alive. Resolves once the process is spawned; restarts happen in
   * the background. Safe to call when librespot isn't installed — the status becomes "missing".
   */
  async start(): Promise<void> {
    const binary = await LibrespotEngine.locate();
    if (binary === null) {
      this.setStatus({ state: "missing" });
      return;
    }

    await mkdir(LIBRESPOT_CACHE_DIR, { recursive: true });
    this.stopped = false;
    this.spawn(binary);
  }

  private spawn(binary: string): void {
    if (this.stopped) return;
    this.setStatus({ state: "starting" });

    // Credentials come from the cache written by the interactive `spotuify auth` run, so no OAuth
    // prompt can appear here and fight the renderer for the terminal.
    const proc = Bun.spawn(
      [
        binary,
        "--name", this.deviceName,
        "--device-type", "computer",
        "--bitrate", "320",
        "--cache", LIBRESPOT_CACHE_DIR,
        "--disable-discovery",
        "--autoplay", "on",
      ],
      { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
    );

    this.proc = proc;
    this.setStatus({ state: "running", pid: proc.pid });

    // Keep the last stderr line so a crash can be reported instead of silently restarting.
    let lastError = "";
    void (async () => {
      const text = await new Response(proc.stderr).text();
      const lines = text.trim().split("\n").filter((l) => l.length > 0);
      lastError = lines.at(-1) ?? "";
    })();

    void (async () => {
      const code = await proc.exited;
      if (this.stopped) return;

      const delay = BACKOFF_MS[Math.min(this.restarts, BACKOFF_MS.length - 1)] ?? 10_000;
      this.restarts++;
      this.setStatus({
        state: "failed",
        reason: lastError.length > 0 ? lastError : `librespot exited with code ${code}`,
      });

      await Bun.sleep(delay);
      this.spawn(binary);
    })();
  }

  /** Stop supervising and kill the child. Must run before the process exits, or librespot leaks. */
  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }
}
