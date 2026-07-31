import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomic } from "./private-file.ts";

function xdgDir(envVar: string, fallback: string): string {
  const base = process.env[envVar];
  return base && base.length > 0 ? base : join(homedir(), fallback);
}

export const CONFIG_DIR = join(xdgDir("XDG_CONFIG_HOME", ".config"), "spotuify");
export const CACHE_DIR = join(xdgDir("XDG_CACHE_HOME", ".cache"), "spotuify");

export const TOKEN_PATH = join(CONFIG_DIR, "token.json");
export const PROFILE_PATH = join(CONFIG_DIR, "profile.json");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const UPDATE_PATH = join(CACHE_DIR, "update.json");
export const LIBRESPOT_CACHE_DIR = join(CACHE_DIR, "librespot");

/**
 * Loopback port for the OAuth redirect. Must match the redirect URI registered in the Spotify
 * dashboard byte-for-byte, so both are derived from one place.
 */
export const REDIRECT_PORT = 8989;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

export const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const TOKEN_URL = "https://accounts.spotify.com/api/token";
export const API_BASE = "https://api.spotify.com/v1";

/** Name the embedded librespot receiver advertises over Spotify Connect. */
export const DEVICE_NAME = "spotuify";

/**
 * Scopes needed for the Web API. `streaming` and `app-remote-control` are deliberately absent —
 * librespot runs its own OAuth flow for the audio session.
 */
export const SCOPES = [
  // `/me` omits `product` and `country` without this; we need `product` to detect Premium and
  // `country` as the market for catalog lookups.
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-follow-read",
  "user-follow-modify",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-read-recently-played",
  "user-read-playback-position",
] as const;

export class MissingClientIdError extends Error {
  constructor() {
    super("Setup required. Run `spotuify auth` to get started.");
    this.name = "MissingClientIdError";
  }
}

/** Resolve the client ID from the environment, falling back to the config file. */
async function readConfig(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};

  const parsed: unknown = await file.json();
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid spotuify config at ${path}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export async function saveClientId(clientId: string, path = CONFIG_PATH): Promise<void> {
  const normalized = clientId.trim();
  if (normalized.length === 0) throw new Error("Client ID cannot be empty.");

  const config = await readConfig(path);
  await writePrivateFileAtomic(
    path,
    `${JSON.stringify({ ...config, clientId: normalized }, null, 2)}\n`,
  );
}

export async function resolveClientId(path = CONFIG_PATH): Promise<string> {
  const fromEnv = process.env["SPOTUIFY_CLIENT_ID"]?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const config = await readConfig(path);
  if (typeof config.clientId === "string" && config.clientId.trim().length > 0) {
    return config.clientId.trim();
  }

  throw new MissingClientIdError();
}
