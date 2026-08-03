import { UPDATE_PATH } from "./config.ts";
import {
  installSource,
  standaloneInstallation,
  type InstallSource,
  type StandaloneTarget,
} from "./distribution.ts";
import { writePrivateFileAtomic } from "./private-file.ts";
import { parseStandaloneManifest, STANDALONE_MANIFEST_URL } from "./standalone-release.ts";
import {
  compareSemanticVersions,
  isSemanticVersion,
  isStableVersion,
  prereleaseIdentifiers,
} from "./semver.ts";

export type UpdateChannel = "latest" | "canary";
type UpdateSource = "npm" | "homebrew" | "standalone";

export interface AvailableUpdate {
  status: "available";
  source: UpdateSource;
  channel: UpdateChannel;
  currentVersion: string;
  latestVersion: string;
  command: string;
  shouldNotify: boolean;
  stale: boolean;
}

export type UpdateCheckResult =
  | AvailableUpdate
  | {
      status: "current";
      source: UpdateSource;
      channel: UpdateChannel;
      currentVersion: string;
      latestVersion: string | null;
      ahead: boolean;
    }
  | { status: "unsupported"; source: "direct" | "source" }
  | { status: "disabled" }
  | { status: "unavailable"; source: UpdateSource; message: string };

interface UpdateCache {
  schema: 1;
  source: UpdateSource;
  channel: UpdateChannel;
  checkedAt: number | null;
  attemptedAt: number;
  latestVersion: string | null;
  etag?: string;
  notifiedVersion?: string;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CheckOptions {
  currentVersion: string;
  source?: InstallSource;
  cachePath?: string;
  fetcher?: Fetcher;
  now?: number;
  signal?: AbortSignal;
  force?: boolean;
  respectOptOut?: boolean;
  env?: NodeJS.ProcessEnv;
  standaloneTarget?: StandaloneTarget;
}

const NPM_METADATA_URL = "https://registry.npmjs.org/spotuify";
const HOMEBREW_METADATA_URL =
  "https://raw.githubusercontent.com/austin-smith/homebrew-tap/main/metadata/spotuify.json";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_RETRY_MS = CHECK_INTERVAL_MS;
const MAX_STALE_RESULT_MS = 7 * 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export const UPDATE_AVAILABLE_EXIT_CODE = 10;

export function updateChannel(version: string): UpdateChannel {
  return prereleaseIdentifiers(version)?.[0] === "canary" ? "canary" : "latest";
}

export function updateCommand(source: UpdateSource, channel: UpdateChannel): string {
  if (source === "homebrew") return "brew update && brew upgrade austin-smith/tap/spotuify";
  if (source === "npm") return `npm install --global spotuify@${channel}`;
  return "spotuify update";
}

export function automaticUpdateChecksEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env["SPOTUIFY_NO_UPDATE_CHECK"] === undefined &&
    env["NO_UPDATE_NOTIFIER"] === undefined &&
    env["CI"] === undefined
  );
}

function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "latest" || value === "canary";
}

function parseCache(value: unknown): UpdateCache | null {
  if (typeof value !== "object" || value === null) return null;
  const cache = value as Partial<UpdateCache>;
  if (
    cache.schema !== 1 ||
    (cache.source !== "npm" && cache.source !== "homebrew" && cache.source !== "standalone") ||
    !isUpdateChannel(cache.channel) ||
    (cache.checkedAt !== null &&
      (typeof cache.checkedAt !== "number" || !Number.isFinite(cache.checkedAt))) ||
    typeof cache.attemptedAt !== "number" ||
    !Number.isFinite(cache.attemptedAt) ||
    (cache.latestVersion !== null && !isSemanticVersion(cache.latestVersion)) ||
    (cache.etag !== undefined && typeof cache.etag !== "string") ||
    (cache.notifiedVersion !== undefined && !isSemanticVersion(cache.notifiedVersion))
  ) {
    return null;
  }
  return cache as UpdateCache;
}

async function readCache(path: string): Promise<UpdateCache | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return parseCache(await file.json());
  } catch {
    return null;
  }
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  await writePrivateFileAtomic(path, `${JSON.stringify(cache, null, 2)}\n`);
}

function cacheMatches(
  cache: UpdateCache | null,
  source: UpdateSource,
  channel: UpdateChannel,
): cache is UpdateCache {
  return cache !== null && cache.source === source && cache.channel === channel;
}

function resultFromVersion(
  source: UpdateSource,
  channel: UpdateChannel,
  currentVersion: string,
  latestVersion: string | null,
  notifiedVersion: string | undefined,
  stale: boolean,
): UpdateCheckResult {
  if (latestVersion === null) {
    return {
      status: "current",
      source,
      channel,
      currentVersion,
      latestVersion: null,
      ahead: false,
    };
  }
  const comparison = compareSemanticVersions(latestVersion, currentVersion);
  if (comparison <= 0) {
    return {
      status: "current",
      source,
      channel,
      currentVersion,
      latestVersion,
      ahead: comparison < 0,
    };
  }
  return {
    status: "available",
    source,
    channel,
    currentVersion,
    latestVersion,
    command: updateCommand(source, channel),
    shouldNotify: notifiedVersion !== latestVersion,
    stale,
  };
}

async function responseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error("update metadata response is too large");
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("update metadata response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function npmLatestVersion(body: string, channel: UpdateChannel): string {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("npm returned invalid update metadata");
  }
  const version = (parsed as { version?: unknown }).version;
  if (!isSemanticVersion(version)) throw new Error(`npm returned an invalid ${channel} version`);
  return version;
}

function homebrewLatestVersion(body: string): string {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Homebrew returned invalid update metadata");
  }
  const metadata = parsed as Record<string, unknown>;
  if (
    metadata["schema"] !== 1 ||
    !isStableVersion(metadata["version"]) ||
    Object.keys(metadata).sort().join(",") !== "schema,version"
  ) {
    throw new Error("Homebrew returned invalid update metadata");
  }
  return metadata["version"];
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "update check was canceled";
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "update check timed out";
  }
  return error instanceof Error ? error.message : String(error);
}

export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheckResult> {
  const source = options.source ?? installSource();
  if (source === "source" || source === "direct") return { status: "unsupported", source };
  if (
    options.respectOptOut !== false &&
    !automaticUpdateChecksEnabled(options.env)
  ) {
    return { status: "disabled" };
  }
  if (!isSemanticVersion(options.currentVersion)) {
    return { status: "unavailable", source, message: "current version is invalid" };
  }
  const standaloneTarget = source === "standalone"
    ? (options.standaloneTarget ?? standaloneInstallation()?.target)
    : undefined;
  if (source === "standalone" && standaloneTarget === undefined) {
    return { status: "unavailable", source, message: "standalone installation is invalid" };
  }

  const channel = source === "npm" ? updateChannel(options.currentVersion) : "latest";
  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? UPDATE_PATH;
  const fetcher = options.fetcher ?? fetch;
  const stored = await readCache(cachePath);
  const cache = cacheMatches(stored, source, channel) ? stored : null;

  if (
    options.force !== true &&
    cache?.checkedAt !== null &&
    cache?.checkedAt !== undefined &&
    now >= cache.checkedAt &&
    now - cache.checkedAt < CHECK_INTERVAL_MS
  ) {
    return resultFromVersion(
      source,
      channel,
      options.currentVersion,
      cache.latestVersion,
      cache.notifiedVersion,
      false,
    );
  }
  if (
    options.force !== true &&
    cache !== null &&
    now >= cache.attemptedAt &&
    now - cache.attemptedAt < FAILURE_RETRY_MS
  ) {
    const stale =
      cache.checkedAt !== null &&
      now >= cache.checkedAt &&
      now - cache.checkedAt <= MAX_STALE_RESULT_MS;
    return stale
      ? resultFromVersion(
          source,
          channel,
          options.currentVersion,
          cache.latestVersion,
          cache.notifiedVersion,
          true,
        )
      : { status: "unavailable", source, message: "update status is temporarily unavailable" };
  }

  const headers = new Headers();
  if (source === "npm") {
    headers.set("Accept", "application/json");
  }
  if (cache?.etag !== undefined) headers.set("If-None-Match", cache.etag);

  try {
    const response = await fetcher(
      source === "npm"
        ? `${NPM_METADATA_URL}/${channel}`
        : source === "homebrew"
          ? HOMEBREW_METADATA_URL
          : STANDALONE_MANIFEST_URL,
      { headers, signal: requestSignal(options.signal) },
    );
    let latestVersion: string | null;
    if (response.status === 304) {
      if (cache === null) throw new Error("update server returned 304 without a cached result");
      latestVersion = cache.latestVersion;
    } else if (source === "npm" && response.status === 404) {
      // A tag-specific npm manifest returns 404 when that publication channel does not exist.
      latestVersion = null;
    } else {
      if (!response.ok) throw new Error(`update server returned ${response.status}`);
      const body = await responseText(response);
      latestVersion = source === "npm"
        ? npmLatestVersion(body, channel)
        : source === "homebrew"
          ? homebrewLatestVersion(body)
          : parseStandaloneManifest(body, standaloneTarget!).version;
    }

    const etag =
      response.status === 304 ? cache?.etag : (response.headers.get("etag") ?? undefined);
    const nextCache: UpdateCache = {
      schema: 1,
      source,
      channel,
      checkedAt: now,
      attemptedAt: now,
      latestVersion,
      ...(etag === undefined ? {} : { etag }),
      ...(cache?.notifiedVersion === latestVersion && latestVersion !== null
        ? { notifiedVersion: latestVersion }
        : {}),
    };
    await writeCache(cachePath, nextCache).catch(() => {});
    return resultFromVersion(
      source,
      channel,
      options.currentVersion,
      latestVersion,
      nextCache.notifiedVersion,
      false,
    );
  } catch (error) {
    if (options.signal?.aborted) {
      return { status: "unavailable", source, message: "update check was canceled" };
    }
    const failureCache: UpdateCache = cache ?? {
      schema: 1,
      source,
      channel,
      checkedAt: null,
      attemptedAt: now,
      latestVersion: null,
    };
    await writeCache(cachePath, { ...failureCache, attemptedAt: now }).catch(() => {});
    if (cache !== null) {
      const stale =
        cache.checkedAt !== null &&
        now >= cache.checkedAt &&
        now - cache.checkedAt <= MAX_STALE_RESULT_MS;
      if (options.force !== true && stale) {
        return resultFromVersion(
          source,
          channel,
          options.currentVersion,
          cache.latestVersion,
          cache.notifiedVersion,
          true,
        );
      }
    }
    return { status: "unavailable", source, message: errorMessage(error) };
  }
}

export async function markUpdateNotified(
  update: AvailableUpdate,
  cachePath = UPDATE_PATH,
): Promise<void> {
  const cache = await readCache(cachePath);
  if (
    cache === null ||
    cache.source !== update.source ||
    cache.channel !== update.channel ||
    cache.latestVersion !== update.latestVersion
  ) {
    return;
  }
  await writeCache(cachePath, { ...cache, notifiedVersion: update.latestVersion }).catch(
    () => {},
  );
}
