import { homedir } from "node:os";
import { join } from "node:path";

function xdgDir(envVar: string, fallback: string): string {
  const base = process.env[envVar];
  return base && base.length > 0 ? base : join(homedir(), fallback);
}

export const CONFIG_DIR = join(xdgDir("XDG_CONFIG_HOME", ".config"), "spotuify");
export const CACHE_DIR = join(xdgDir("XDG_CACHE_HOME", ".cache"), "spotuify");

export const TOKEN_PATH = join(CONFIG_DIR, "token.json");
export const PROFILE_PATH = join(CONFIG_DIR, "profile.json");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
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
    super(
      [
        "No Spotify client ID configured.",
        "",
        "  1. Create an app at https://developer.spotify.com/dashboard",
        `  2. Add exactly this redirect URI: ${REDIRECT_URI}`,
        "  3. Then either:",
        `       export SPOTUIFY_CLIENT_ID=<your client id>`,
        `     or write {"clientId": "<your client id>"} to ${CONFIG_PATH}`,
      ].join("\n"),
    );
    this.name = "MissingClientIdError";
  }
}

/** Resolve the client ID from the environment, falling back to the config file. */
export async function resolveClientId(): Promise<string> {
  const fromEnv = process.env["SPOTUIFY_CLIENT_ID"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const file = Bun.file(CONFIG_PATH);
  if (await file.exists()) {
    const parsed = (await file.json()) as { clientId?: unknown };
    if (typeof parsed.clientId === "string" && parsed.clientId.length > 0) {
      return parsed.clientId;
    }
  }

  throw new MissingClientIdError();
}
