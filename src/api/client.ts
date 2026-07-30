import { API_BASE } from "../config.ts";
import type { TokenStore } from "../auth/tokens.ts";

export class SpotifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** Spotify's own message, without the status and path this prefixes onto it. */
    readonly detail: string,
    /** Machine-readable reason Spotify includes on selected errors. */
    readonly reason: string | null = null,
  ) {
    super(`Spotify API ${status} on ${path}: ${detail}`);
    this.name = "SpotifyApiError";
  }
}

/**
 * Spotify has two independent 429 mechanisms:
 *
 * - the ordinary rolling-window rate limit;
 * - Development Mode quota exhaustion (`QUOTA_EXCEEDED`).
 *
 * Keeping the reason and absolute retry time typed prevents the UI and scheduler from treating a
 * multi-hour quota lockout as a transient "try again in a moment" failure.
 */
export class SpotifyLimitError extends SpotifyApiError {
  constructor(
    path: string,
    detail: string,
    reason: string | null,
    /** Absolute wall-clock time. `null` means Spotify omitted a usable Retry-After value. */
    readonly retryAt: number | null,
  ) {
    super(429, path, detail, reason);
    this.name = "SpotifyLimitError";
  }

  get quotaExceeded(): boolean {
    return this.reason === "QUOTA_EXCEEDED";
  }
}

/**
 * Spotify declined a transport command as inapplicable.
 *
 * `403 Player command failed: …` is an outcome, not a fault: pressing previous at the start of a
 * context answers `Restriction violated`, which is Spotify's way of saying there is nothing to go
 * back to, and its own clients simply do nothing. Typed separately so callers can ignore it instead
 * of reporting a failure the user cannot act on.
 */
export class PlayerCommandRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PlayerCommandRejectedError";
  }
}

/** Playback control returns 403 for free accounts and when no device is active. */
export class PremiumRequiredError extends Error {
  constructor() {
    super("This action requires Spotify Premium.");
    this.name = "PremiumRequiredError";
  }
}

export interface RequestOptions {
  method?: string;
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Foreground work uses the interactive lane instead of waiting behind background polling. */
  priority?: "foreground" | "background";
}

export interface SpotifyCooldown {
  kind: "rate-limit" | "quota";
  /** `null` means Spotify did not supply a valid Retry-After value. */
  retryAt: number | null;
  detail: string;
}

export interface SpotifyRequestMetrics {
  networkRequests: number;
  coalescedRequests: number;
  blockedRequests: number;
  byPath: Readonly<Record<string, number>>;
}

/**
 * Combine concurrent 429 responses without weakening a cooldown that Spotify already established.
 *
 * An unknown retry time is intentionally fail-closed, so it is stricter than any finite deadline.
 * Quota classification is also retained independently of which response supplied the deadline.
 */
function mergeCooldown(
  current: SpotifyCooldown | null,
  next: SpotifyCooldown,
): SpotifyCooldown {
  if (current === null) return next;

  const kind =
    current.kind === "quota" || next.kind === "quota" ? "quota" : "rate-limit";
  const retryAt =
    current.retryAt === null || next.retryAt === null
      ? null
      : Math.max(current.retryAt, next.retryAt);

  const detail =
    kind === "quota"
      ? current.kind === "quota"
        ? current.detail
        : next.detail
      : retryAt === current.retryAt
        ? current.detail
        : next.detail;

  return { kind, retryAt, detail };
}

interface SpotifyClientOptions {
  now?: () => number;
}

interface ParsedError {
  message: string;
  reason: string | null;
}

interface ScheduledRequest {
  priority: "foreground" | "background";
  path: string;
  signal: AbortSignal | undefined;
  /** Exact indefinite cooldown revision this user-initiated request may probe. */
  allowedIndefiniteCooldownRevision: number | null;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * Authenticated Spotify Web API client.
 *
 * Foreground and background calls each have one serialized lane. The separate lanes prevent a
 * slow library read from blocking an interactive search, while bounding this client to at most two
 * requests in flight. Both lanes share one cooldown: once Spotify says to stop, every queued
 * request observes it before reaching the network. Spotify does not publish a safe fixed request
 * interval, so this client does not invent one; recurring work is budgeted at its source and 429s
 * obey `Retry-After`.
 */
export class SpotifyClient {
  private readonly now: () => number;
  private readonly queue: ScheduledRequest[] = [];
  private foregroundActive = false;
  private backgroundActive = false;
  private cooldown: SpotifyCooldown | null = null;
  /** Distinguishes the cooldown a manual probe observed from a newer concurrent 429. */
  private cooldownRevision = 0;
  private readonly inFlightGets = new Map<string, Promise<unknown>>();
  private networkRequests = 0;
  private coalescedRequests = 0;
  private blockedRequests = 0;
  private readonly requestsByPath = new Map<string, number>();

  constructor(
    private readonly tokens: TokenStore,
    options: SpotifyClientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    return await this.requestWithPolicy<T>(path, options, false);
  }

  /**
   * Make one explicit user-initiated GET through an indefinite cooldown.
   *
   * Ordinary and finite cooldowns are still enforced. Other queued requests remain blocked while
   * this probe runs, and any new 429 immediately closes the circuit again.
   */
  async retryAfterIndefiniteCooldown<T>(path: string): Promise<T> {
    const result = await this.requestWithPolicy<T>(path, {}, true);
    if (result === null) throw new SpotifyApiError(204, path, "Expected a response body.");
    return result;
  }

  private async requestWithPolicy<T>(
    path: string,
    options: RequestOptions,
    probeIndefiniteCooldown: boolean,
  ): Promise<T | null> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const method = (options.method ?? "GET").toUpperCase();
    const cooldown = probeIndefiniteCooldown ? this.getCooldown() : null;
    const allowedIndefiniteCooldownRevision =
      cooldown?.retryAt === null ? this.cooldownRevision : null;
    // A caller-owned AbortSignal cannot safely be shared: aborting one consumer would cancel every
    // consumer. The state and device reads that matter for coalescing do not carry signals.
    const dedupeKey =
      !probeIndefiniteCooldown && method === "GET" && options.signal === undefined
        ? url.href
        : null;
    if (dedupeKey !== null) {
      const existing = this.inFlightGets.get(dedupeKey);
      if (existing !== undefined) {
        this.coalescedRequests++;
        return (await existing) as T | null;
      }
    }

    const pending = this.schedule(
      path,
      options.signal,
      options.priority ?? "foreground",
      allowedIndefiniteCooldownRevision,
      () =>
        this.execute<T>(
          path,
          url,
          method,
          options,
          allowedIndefiniteCooldownRevision,
        ),
    );
    if (dedupeKey !== null) {
      this.inFlightGets.set(dedupeKey, pending);
      const clear = () => {
        if (this.inFlightGets.get(dedupeKey) === pending) this.inFlightGets.delete(dedupeKey);
      };
      void pending.then(clear, clear);
    }
    return await pending;
  }

  /** `request` for endpoints that always return a body. */
  async get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    const result = await this.request<T>(path, query ? { query } : {});
    if (result === null) throw new SpotifyApiError(204, path, "Expected a response body.");
    return result;
  }

  /** Current client-wide Spotify cooldown, clearing it once its advertised time has elapsed. */
  getCooldown(): SpotifyCooldown | null {
    if (
      this.cooldown !== null &&
      this.cooldown.retryAt !== null &&
      this.now() >= this.cooldown.retryAt
    ) {
      this.cooldown = null;
      this.cooldownRevision++;
    }
    return this.cooldown === null ? null : { ...this.cooldown };
  }

  /** Read-only counters for request-budget assertions and opt-in diagnostics. */
  getMetrics(): SpotifyRequestMetrics {
    return {
      networkRequests: this.networkRequests,
      coalescedRequests: this.coalescedRequests,
      blockedRequests: this.blockedRequests,
      byPath: Object.fromEntries(this.requestsByPath),
    };
  }

  private schedule<T>(
    path: string,
    signal: AbortSignal | undefined,
    priority: "foreground" | "background",
    allowedIndefiniteCooldownRevision: number | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    const scheduled = new Promise<T>((resolve, reject) => {
      this.queue.push({
        priority,
        path,
        signal,
        allowedIndefiniteCooldownRevision,
        operation,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
    return scheduled;
  }

  private pump(): void {
    this.startNext("foreground");
    this.startNext("background");
  }

  private startNext(priority: "foreground" | "background"): void {
    if (priority === "foreground" ? this.foregroundActive : this.backgroundActive) return;
    const index = this.queue.findIndex((request) => request.priority === priority);
    if (index === -1) return;
    const [request] = this.queue.splice(index, 1);
    if (request === undefined) return;

    if (priority === "foreground") this.foregroundActive = true;
    else this.backgroundActive = true;

    void this.run(request).finally(() => {
      if (priority === "foreground") this.foregroundActive = false;
      else this.backgroundActive = false;
      this.pump();
    });
  }

  private async run(request: ScheduledRequest): Promise<void> {
    try {
      this.throwIfBlocked(request.path, request.allowedIndefiniteCooldownRevision);
      throwIfAborted(request.signal);
      request.resolve(await request.operation());
    } catch (error) {
      request.reject(error);
    }
  }

  private throwIfBlocked(
    path: string,
    allowedIndefiniteCooldownRevision: number | null = null,
  ): void {
    const cooldown = this.getCooldown();
    if (cooldown === null) return;
    if (
      allowedIndefiniteCooldownRevision !== null &&
      this.cooldownRevision === allowedIndefiniteCooldownRevision &&
      cooldown.retryAt === null
    ) {
      return;
    }
    this.blockedRequests++;
    throw new SpotifyLimitError(
      path,
      cooldown.detail,
      cooldown.kind === "quota" ? "QUOTA_EXCEEDED" : null,
      cooldown.retryAt,
    );
  }

  private async execute<T>(
    path: string,
    url: URL,
    method: string,
    options: RequestOptions,
    allowedIndefiniteCooldownRevision: number | null,
  ): Promise<T | null> {
    let refreshed = false;

    while (true) {
      // The other lane may have established a cooldown after this operation was admitted.
      this.throwIfBlocked(path, allowedIndefiniteCooldownRevision);
      const accessToken = await this.tokens.accessToken();
      // Token retrieval can itself wait on a refresh, so check again at the last safe point before
      // reaching Spotify.
      this.throwIfBlocked(path, allowedIndefiniteCooldownRevision);
      const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
      if (options.body !== undefined) headers["content-type"] = "application/json";

      this.networkRequests++;
      this.requestsByPath.set(path, (this.requestsByPath.get(path) ?? 0) + 1);
      const res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // Any concrete non-429 response proves that the indefinite server-side cooldown observed by
      // this probe no longer blocks requests. Do not clear a newer cooldown established by the
      // other request lane while the probe was in flight.
      if (
        res.status !== 429 &&
        allowedIndefiniteCooldownRevision !== null &&
        this.cooldownRevision === allowedIndefiniteCooldownRevision &&
        this.cooldown?.retryAt === null
      ) {
        this.cooldown = null;
        this.cooldownRevision++;
      }

      if (res.status === 204) return null;

      if (res.ok) {
        if (res.headers.get("content-length") === "0") return null;
        const text = await res.text();
        // Only a body Spotify labels as JSON is parsed as JSON. The transport endpoints answer 200
        // with a bare command id and no content-type at all.
        if (text.length === 0 || !isJson(res)) return null;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new SpotifyApiError(res.status, path, "Response was not valid JSON.");
        }
      }

      const parsed = await parseError(res);

      // A 401 response did not apply the operation. Refresh the token once and repeat through the
      // same serialized lane; TokenStore itself coalesces concurrent refreshes.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.tokens.refresh();
        throwIfAborted(options.signal);
        continue;
      }

      if (res.status === 429) {
        const retryAt = parseRetryAt(res.headers.get("retry-after"), this.now());
        const kind = parsed.reason === "QUOTA_EXCEEDED" ? "quota" : "rate-limit";
        // The response to an explicit probe supersedes the exact indefinite cooldown that allowed
        // it through. A concurrently established cooldown still merges conservatively.
        const previous =
          allowedIndefiniteCooldownRevision !== null &&
          this.cooldownRevision === allowedIndefiniteCooldownRevision
            ? null
            : this.getCooldown();
        const cooldown = mergeCooldown(previous, {
          kind,
          retryAt,
          detail: parsed.message,
        });
        this.cooldown = cooldown;
        this.cooldownRevision++;
        throw new SpotifyLimitError(
          path,
          cooldown.detail,
          cooldown.kind === "quota" ? "QUOTA_EXCEEDED" : null,
          cooldown.retryAt,
        );
      }

      if (res.status === 403 && /premium/i.test(parsed.message)) {
        throw new PremiumRequiredError();
      }
      // "Player command failed: Restriction violated" and friends: the command did not apply, which
      // is a normal outcome rather than something to report.
      if (res.status === 403 && /^player command failed/i.test(parsed.message)) {
        throw new PlayerCommandRejectedError(
          parsed.message.replace(/^player command failed:\s*/i, ""),
        );
      }
      throw new SpotifyApiError(res.status, path, parsed.message, parsed.reason);
    }
  }
}

/** Whether Spotify labeled the body as JSON. Transport commands send no content-type at all. */
function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("json");
}

async function parseError(res: Response): Promise<ParsedError> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; reason?: unknown } };
    return {
      message:
        typeof parsed.error?.message === "string" ? parsed.error.message : res.statusText,
      reason: typeof parsed.error?.reason === "string" ? parsed.error.reason : null,
    };
  } catch {
    return { message: text.length > 0 ? text : res.statusText, reason: null };
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAt(value: string | null, now: number): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
