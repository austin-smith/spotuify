import { create } from "zustand";
import {
  PlayerCommandRejectedError,
  PremiumRequiredError,
  SpotifyApiError,
  SpotifyLimitError,
} from "../api/client.ts";
import { PlayerApi, nextRepeatState } from "../api/player.ts";
import type { PlayableItem, PlaybackState, RepeatState } from "../api/types.ts";
import { ReauthRequiredError } from "../auth/tokens.ts";
import { DEVICE_NAME } from "../config.ts";
import {
  type EngineEvent,
  LibrespotEngine,
  NativePlaybackUnavailableError,
} from "../engine/librespot.ts";
import { extrapolate, type ProgressAnchor } from "./progress.ts";

/** Reconcile remote playback while it is moving; progress itself is extrapolated locally. */
export const ACTIVE_POLL_INTERVAL_MS = 30_000;
/** Paused or empty playback changes less often and should not consume an active-session budget. */
export const IDLE_POLL_INTERVAL_MS = 60_000;
/** Let Spotify Connect settle, then perform at most one coalesced reconciliation. */
export const COMMAND_RECONCILE_MS = 750;
/** One bounded follow-up read when Spotify has not exposed a just-started selection yet. */
export const SELECTION_RECONCILE_RETRY_MS = 1_000;
/** Let a newly connected native receiver publish playback before surfacing a stale Web failure. */
export const NATIVE_TAKEOVER_GRACE_MS = 1_000;
/** How often to recompute extrapolated progress for the UI. */
const TICK_INTERVAL_MS = 250;
/**
 * How long an error stays up before it may clear.
 *
 * Remote failures remain visible across the command's reconciliation read; transient native
 * failures use the same readable window without spending a Web API request.
 */
export const ERROR_LINGER_MS = 4_000;

export type PlaybackSessionPresence = "unknown" | "absent" | "present";

export interface PlaybackSelectionPreview {
  label: string;
  item?: PlayableItem;
}

export interface PlaybackSelectionOptions {
  contextUri?: string;
  uris?: string[];
  offset?: number;
}

export type PlaybackSelectionConfirmation =
  | { kind: "item"; uri: string }
  | { kind: "context"; uri: string }
  | null;

export type PlaybackSelectionLane = "native" | "web";

export interface PendingPlaybackSelection {
  /** Monotonic identity so an older command cannot clear a newer selection. */
  requestId: number;
  label: string;
  /** Full metadata is available for track rows and lets an empty canvas render immediately. */
  item: PlayableItem | null;
  /** Requested playback identity used to reject stale post-command Web snapshots. */
  confirmation: PlaybackSelectionConfirmation;
  /** The first matching Web snapshot is ambiguous because it could predate the command. */
  requiresFollowUp: boolean;
  /** The control lane whose acknowledgement is allowed to finish this transition. */
  lane: PlaybackSelectionLane;
}

export interface PlaybackStartOptions {
  /**
   * Keep native events active while another owner performs the sole Web API recovery probe.
   *
   * Call `resumeWebReconciliation` after that probe succeeds.
   */
  suspendWebReconciliation?: boolean;
}

export interface PlaybackSlice {
  item: PlayableItem | null;
  /** A user selection awaiting authoritative native or Web playback confirmation. */
  pendingSelection: PendingPlaybackSelection | null;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatState;
  volumePercent: number | null;
  deviceId: string | null;
  deviceName: string | null;
  /**
   * Whether a successful source has established that a Spotify playback session exists.
   *
   * Device and item identifiers are independently nullable, so neither can safely stand in for this
   * state. `unknown` includes startup, failed reads, and the gap after a native disconnect.
   */
  sessionPresence: PlaybackSessionPresence;
  /** Extrapolated position, refreshed every tick. */
  progressMs: number;
  durationMs: number;
  /** Last error surfaced to the user; transient native-command failures expire independently. */
  error: string | null;
  /** False until the first poll resolves, so the UI can show a loading state. */
  ready: boolean;

  start: (
    player: PlayerApi,
    engine?: LibrespotEngine,
    accountId?: string | null,
    options?: PlaybackStartOptions,
  ) => () => void;
  refresh: (priority?: "foreground" | "background") => Promise<void>;
  /** Pause and cancel playback reads while another owner uses the shared Web API client. */
  suspendWebReconciliation: () => void;
  /** Resume Web reads after a coordinated account-recovery probe and reconcile once if needed. */
  resumeWebReconciliation: () => Promise<void>;
  /** Coalesce command and picker updates into one delayed playback read. */
  reconcileSoon: () => void;
  /** Record a successful remote-device transfer before Spotify's next playback snapshot arrives. */
  confirmDeviceTransfer: (deviceId: string, deviceName: string) => void;
  playSelection: (
    options: PlaybackSelectionOptions,
    preview?: PlaybackSelectionPreview,
  ) => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seekBy: (deltaMs: number) => Promise<void>;
  adjustVolume: (delta: number) => Promise<void>;
  toggleShuffle: () => Promise<void>;
  cycleRepeat: () => Promise<void>;
}

/** Mutable, non-reactive internals — kept out of the store so they never trigger a render. */
let api: PlayerApi | null = null;
let native: LibrespotEngine | null = null;
/** Verified Web API account identity. Null means native control must remain unavailable. */
let webAccountId: string | null = null;
let anchor: ProgressAnchor = { progressMs: 0, atMs: 0, isPlaying: false, durationMs: 0 };
interface NativeTransportPhase {
  uri: string;
  isPlaying: boolean;
  positionMs: number;
  atMs: number;
}
/** Latest native transport phase, retained so metadata and phase may arrive in either order. */
let nativeTransportPhase: NativeTransportPhase | null = null;
/** When the current error was raised, for `ERROR_LINGER_MS`. */
let errorAt = 0;
let errorRevision = 0;
let errorClearTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshController: AbortController | null = null;
let runId = 0;
/** Invalidates a public-API response when a newer native player event arrives first. */
let nativeRevision = 0;
/** Authoritative Connect activity; a ready sidecar may still be an inactive available receiver. */
let nativeSessionConnected = false;
/** A confirmed remote transfer owns playback until Connect proves a new local session. */
let remoteTransferConfirmed = false;
/** Device identity rejected after an authoritative local disconnect until Web state moves away. */
let disconnectedNativeDeviceId: string | null = null;
let nativeDisconnectRetryCount = 0;
/** Another owner is using the shared client for the sole quota-recovery probe. */
let webReconciliationSuspended = false;
/** Invalidates playback reads across the complete lifetime of a Web API mutation. */
let webMutationRevision = 0;
let webMutationsInFlight = 0;
/** Most recent mutation revision for which a playback read was actually started. */
let latestRefreshRevision = -1;
let latestRefreshStartedAt = Number.NEGATIVE_INFINITY;
/** Reads before this monotonic deadline are too early to reconcile Spotify's eventual state. */
let webReadNotBefore = Number.NEGATIVE_INFINITY;
let selectionRequestId = 0;
let selectionConfirmationRetries = 0;
let pendingSelectionResolutionTimer: ReturnType<typeof setTimeout> | null = null;
/** Web selection whose command completed while native playback owns reconciliation. */
let settledWebSelectionRequestId: number | null = null;
type OptimisticField = "playing" | "progress" | "volume" | "shuffle" | "repeat";
interface ConfirmedPlayback {
  anchor: ProgressAnchor;
  volumePercent: number | null;
  shuffle: boolean;
  repeat: RepeatState;
}

let confirmed: ConfirmedPlayback = {
  anchor: { progressMs: 0, atMs: 0, isPlaying: false, durationMs: 0 },
  volumePercent: null,
  shuffle: false,
  repeat: "off",
};
const optimisticVersion: Record<OptimisticField, number> = {
  playing: 0,
  progress: 0,
  volume: 0,
  shuffle: 0,
  repeat: 0,
};
const nativeFieldVersion: Record<OptimisticField, number> = {
  playing: 0,
  progress: 0,
  volume: 0,
  shuffle: 0,
  repeat: 0,
};
/** Latest optimistic mutation incorporated into the authoritative rollback baseline. */
const confirmedOptimisticVersion: Record<OptimisticField, number> = {
  playing: 0,
  progress: 0,
  volume: 0,
  shuffle: 0,
  repeat: 0,
};
/** A 429 moves the next background request to Spotify's absolute retry time. */
let pollNotBefore = 0;
let unsubscribeNative: (() => void) | null = null;

interface OptimisticGuard {
  field: OptimisticField;
  optimistic: number;
  native: number;
}

type FieldRevision = Pick<OptimisticGuard, "optimistic" | "native">;

function fieldRevision(field: OptimisticField): FieldRevision {
  return {
    optimistic: optimisticVersion[field],
    native: nativeFieldVersion[field],
  };
}

function beginOptimistic(field: OptimisticField): OptimisticGuard {
  optimisticVersion[field]++;
  return {
    field,
    optimistic: optimisticVersion[field],
    native: nativeFieldVersion[field],
  };
}

function revisionMatches(field: OptimisticField, revision: FieldRevision): boolean {
  return (
    optimisticVersion[field] === revision.optimistic &&
    nativeFieldVersion[field] === revision.native
  );
}

function mayRollback(guard: OptimisticGuard): boolean {
  return revisionMatches(guard.field, guard);
}

function markAuthoritative(...fields: OptimisticField[]): void {
  for (const field of fields) {
    confirmedOptimisticVersion[field] = optimisticVersion[field];
  }
}

function confirmOptimisticSuccess(guard: OptimisticGuard, apply: () => void): void {
  if (
    guard.native !== nativeFieldVersion[guard.field] ||
    guard.optimistic <= confirmedOptimisticVersion[guard.field]
  ) {
    return;
  }
  confirmedOptimisticVersion[guard.field] = guard.optimistic;
  apply();
}

function noteNative(...fields: OptimisticField[]): void {
  for (const field of fields) nativeFieldVersion[field]++;
  markAuthoritative(...fields);
}

function materializeAnchor(value: ProgressAnchor, now = performance.now()): ProgressAnchor {
  return {
    ...value,
    progressMs: extrapolate(value, now),
    atMs: now,
  };
}

function confirmFromStore(state: PlaybackSlice): void {
  confirmed = {
    anchor: {
      progressMs: state.progressMs,
      atMs: performance.now(),
      isPlaying: state.isPlaying,
      durationMs: state.durationMs,
    },
    volumePercent: state.volumePercent,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };
  markAuthoritative("playing", "progress", "volume", "shuffle", "repeat");
}

/**
 * Playback position right now, extrapolated from the last poll.
 *
 * The store writes `progressMs` only when the displayed second changes, which is deliberately too
 * coarse to animate against. Anything needing finer steps — the lyric follow — reads this instead,
 * so a 10Hz animation costs no store writes and re-renders nothing else.
 */
export function positionMs(): number {
  return extrapolate(anchor, performance.now());
}

function applyState(state: PlaybackState | null): Partial<PlaybackSlice> {
  if (state === null) {
    anchor = { progressMs: 0, atMs: performance.now(), isPlaying: false, durationMs: 0 };
    confirmed = {
      anchor: { ...anchor },
      volumePercent: null,
      shuffle: false,
      repeat: "off",
    };
    markAuthoritative("playing", "progress", "volume", "shuffle", "repeat");
    return {
      item: null,
      isPlaying: false,
      shuffle: false,
      repeat: "off",
      volumePercent: null,
      progressMs: 0,
      durationMs: 0,
      deviceId: null,
      deviceName: null,
      sessionPresence: "absent",
      ready: true,
    };
  }

  const durationMs = state.item?.duration_ms ?? 0;
  anchor = {
    progressMs: state.progress_ms ?? 0,
    atMs: performance.now(),
    isPlaying: state.is_playing,
    durationMs,
  };
  confirmed = {
    anchor: { ...anchor },
    volumePercent: state.device?.volume_percent ?? null,
    shuffle: state.shuffle_state,
    repeat: state.repeat_state,
  };
  markAuthoritative("playing", "progress", "volume", "shuffle", "repeat");

  return {
    item: state.item,
    isPlaying: state.is_playing,
    shuffle: state.shuffle_state,
    repeat: state.repeat_state,
    volumePercent: state.device?.volume_percent ?? null,
    deviceId: state.device?.id ?? null,
    deviceName: state.device?.name ?? null,
    sessionPresence: "present",
    progressMs: anchor.progressMs,
    durationMs,
    ready: true,
  };
}

/**
 * A sentence the user can act on.
 *
 * Raw API text ("Spotify API 404 on /me/player/next: Device not found") names an endpoint the user
 * never asked about and says nothing about what to do next.
 */
function describe(err: unknown): string {
  if (err instanceof PremiumRequiredError) return "playback control needs spotify premium";
  if (err instanceof ReauthRequiredError) return "session expired — run: spotuify auth";

  if (err instanceof SpotifyApiError) {
    if (err.status === 404) return "no active device — press d to pick one";
    if (err instanceof SpotifyLimitError) {
      const prefix = err.quotaExceeded ? "spotify api quota exhausted" : "spotify is rate limiting";
      if (err.retryAt === null) return `${prefix} — spotify supplied no retry time`;
      const at = new Date(err.retryAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      return `${prefix} — retry after ${at}`;
    }
    if (err.status >= 500) return "spotify is having trouble — retrying";
    return err.detail.toLowerCase();
  }

  // Offline and DNS failures arrive as TypeError from fetch, with a message that varies by platform.
  if (err instanceof TypeError) return "cannot reach spotify — check your connection";
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a failure, unless Spotify merely declined the command.
 *
 * A rejected transport command is an outcome, not a fault: pressing previous at the start of a
 * context cannot go anywhere, and Spotify's own clients do nothing rather than complain.
 */
function fail(
  set: (patch: Partial<PlaybackSlice>) => void,
  err: unknown,
  lifetime: "until-success" | "transient" = "until-success",
): void {
  if (err instanceof PlayerCommandRejectedError) return;
  if (err instanceof SpotifyLimitError) {
    // With no usable Retry-After, fail closed for this client session. A manual refresh still gives
    // immediate feedback from the shared gate without reaching Spotify.
    pollNotBefore = err.retryAt ?? Number.POSITIVE_INFINITY;
  }
  clearTimer(errorClearTimer);
  errorClearTimer = null;
  const revision = ++errorRevision;
  errorAt = performance.now();
  const message = describe(err);
  set({ error: message });
  if (lifetime === "transient") {
    scheduleErrorClear(set, message, revision, ERROR_LINGER_MS);
  }
}

function scheduleErrorClear(
  set: (patch: Partial<PlaybackSlice>) => void,
  message: string,
  revision: number,
  delayMs: number,
): void {
  clearTimer(errorClearTimer);
  errorClearTimer = setTimeout(() => {
    errorClearTimer = null;
    if (errorRevision === revision && usePlayback.getState().error === message) {
      set({ error: null });
    }
  }, Math.max(0, delayMs));
}

/** Whether a successful poll may clear the error that is up. */
function errorIsStale(current: string | null): boolean {
  return current !== null && performance.now() - errorAt >= ERROR_LINGER_MS;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

function nextPollDelay(
  state: Pick<PlaybackSlice, "item" | "isPlaying" | "deviceId">,
): number | null {
  // Native events are authoritative for the local receiver. Polling the public Web API while it is
  // active would duplicate those events and spend Development Mode quota for no information.
  if (isNativeDevice(state.deviceId)) return null;
  if (pollNotBefore === Number.POSITIVE_INFINITY) return null;
  const blockedFor = pollNotBefore - Date.now();
  if (blockedFor > 0) return blockedFor;
  return state.item !== null && state.isPlaying
    ? ACTIVE_POLL_INTERVAL_MS
    : IDLE_POLL_INTERVAL_MS;
}

function schedulePoll(get: () => PlaybackSlice, expectedRun: number): void {
  clearTimer(pollTimer);
  pollTimer = null;
  if (api === null || expectedRun !== runId || webReconciliationSuspended) return;

  const delay = nextPollDelay(get());
  if (delay === null) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void get().refresh();
  }, delay);
}

function scheduleReconciliation(
  get: () => PlaybackSlice,
  requiredRevision: number,
  notBefore: number,
): void {
  if (webReconciliationSuspended || isNativeDevice(get().deviceId)) return;
  const expectedRun = runId;
  const expectedApi = api;
  clearTimer(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    if (api === null || api !== expectedApi || runId !== expectedRun) return;
    if (performance.now() < notBefore) {
      scheduleReconciliation(get, requiredRevision, notBefore);
      return;
    }
    void (async () => {
      // An older read cannot satisfy this barrier. Wait for it to leave the single-flight slot,
      // then ensure a read was started after the mutation that requested reconciliation.
      const pending = refreshInFlight;
      if (pending !== null) await pending;
      if (
        api === null ||
        api !== expectedApi ||
        runId !== expectedRun ||
        (latestRefreshRevision >= requiredRevision &&
          latestRefreshStartedAt >= notBefore)
      ) {
        return;
      }
      await get().refresh();
    })();
  }, Math.max(0, Math.ceil(notBefore - performance.now())));
}

interface WebMutationGuard {
  run: number;
}

function beginWebMutation(): WebMutationGuard {
  clearTimer(pollTimer);
  pollTimer = null;
  webMutationRevision++;
  webMutationsInFlight++;
  return { run: runId };
}

function finishWebMutation(get: () => PlaybackSlice, guard: WebMutationGuard): void {
  if (guard.run !== runId) return;
  webMutationsInFlight = Math.max(0, webMutationsInFlight - 1);
  const settledRevision = ++webMutationRevision;
  // Concurrent slider/key commands share one read after the last mutation settles. Starting reads
  // while another mutation remains pending would spend quota on a snapshot we must discard.
  if (webMutationsInFlight === 0) {
    webReadNotBefore = performance.now() + COMMAND_RECONCILE_MS;
    scheduleReconciliation(get, settledRevision, webReadNotBefore);
  }
}

function reconcileCompletedWebMutation(
  get: () => PlaybackSlice,
  delayMs = COMMAND_RECONCILE_MS,
): void {
  const settledRevision = ++webMutationRevision;
  if (webMutationsInFlight === 0) {
    webReadNotBefore = performance.now() + delayMs;
    scheduleReconciliation(get, settledRevision, webReadNotBefore);
  }
}

function isNativeDevice(deviceId: string | null): boolean {
  const status = native?.getStatus();
  return (
    webAccountId !== null &&
    nativeConnectionActive() &&
    status?.state === "ready" &&
    status.accountId === webAccountId &&
    deviceId === status.deviceId
  );
}

function selectionMatchesState(
  selection: PendingPlaybackSelection | null,
  state: PlaybackState | null,
): boolean {
  if (selection === null || selection.confirmation === null || state === null) return false;
  return selection.confirmation.kind === "item"
    ? state.item?.uri === selection.confirmation.uri
    : state.context?.uri === selection.confirmation.uri;
}

function selectionConfirmationFor(
  options: PlaybackSelectionOptions,
  preview: PlaybackSelectionPreview | undefined,
): PlaybackSelectionConfirmation {
  const itemUri = preview?.item?.uri ?? options.uris?.[0];
  if (itemUri !== undefined) return { kind: "item", uri: itemUri };
  if (options.contextUri !== undefined) return { kind: "context", uri: options.contextUri };
  return null;
}

function selectionRequiresFollowUp(
  confirmation: PlaybackSelectionConfirmation,
  current: Pick<PlaybackSlice, "item" | "sessionPresence">,
): boolean {
  if (confirmation === null) return false;
  // Unknown playback, a context-only selection, and replaying the current URI all make an item
  // match indistinguishable from a stale pre-command snapshot. Spend the one bounded follow-up
  // read in those cases, but not after Spotify has authoritatively confirmed an absent session.
  return (
    current.sessionPresence === "unknown" ||
    confirmation.kind === "context" ||
    current.item?.uri === confirmation.uri
  );
}

function clearPendingSelection(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  requestId: number,
): void {
  if (get().pendingSelection?.requestId !== requestId) return;
  resetPendingSelectionTracking(requestId);
  set({ pendingSelection: null });
}

function resetPendingSelectionTracking(requestId: number): void {
  clearTimer(pendingSelectionResolutionTimer);
  pendingSelectionResolutionTimer = null;
  if (settledWebSelectionRequestId === requestId) settledWebSelectionRequestId = null;
  selectionConfirmationRetries = 0;
}

function movePendingSelectionToWeb(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  requestId: number,
): void {
  const pendingSelection = get().pendingSelection;
  if (pendingSelection?.requestId !== requestId || pendingSelection.lane === "web") return;
  set({ pendingSelection: { ...pendingSelection, lane: "web" } });
}

type NativeSelectionEvidence =
  | { kind: "connected" }
  | { kind: "metadata"; uri: string }
  | { kind: "transport"; uri: string }
  | { kind: "complete"; uri: string };

function updatePendingWebSelectionFromNative(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  evidence: NativeSelectionEvidence | null,
): void {
  const state = get();
  const pendingSelection = state.pendingSelection;
  if (evidence === null || pendingSelection?.lane !== "web") return;
  if (
    evidence.kind === "complete" &&
    pendingSelection.confirmation?.kind === "item" &&
    pendingSelection.confirmation.uri === evidence.uri
  ) {
    clearPendingSelection(set, get, pendingSelection.requestId);
    return;
  }
  // Do not start the grace period while the Web command can still settle normally. Remembering
  // settlement by request keeps an older command or native event from timing out a newer preview.
  if (settledWebSelectionRequestId !== pendingSelection.requestId) return;
  // Incomplete native evidence cannot confirm the request, and even complete native playback
  // cannot prove a context URI. Keep the preview briefly, then yield to native authority.
  deferPendingSelectionResolution(set, get, pendingSelection.requestId, {
    kind: "superseded",
  });
}

function settlePendingWebSelection(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  requestId: number,
): void {
  const pendingSelection = get().pendingSelection;
  if (pendingSelection?.requestId !== requestId || pendingSelection.lane !== "web") return;
  settledWebSelectionRequestId = requestId;
  if (isNativeDevice(get().deviceId)) {
    // Native takeover may have arrived before the Web promise settled. The current native device
    // is enough to bound the transition; exact phase/metadata evidence may still finish it sooner.
    deferPendingSelectionResolution(set, get, requestId, { kind: "superseded" });
  }
}

type PendingSelectionResolution =
  | { kind: "superseded" }
  | { kind: "failed"; error: unknown };

function promotePendingSelectionFromNativeTransport(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  requestId: number,
): boolean {
  const pendingSelection = get().pendingSelection;
  const item = pendingSelection?.requestId === requestId ? pendingSelection.item : null;
  const transport = nativeTransportPhase;
  if (item === null || transport?.uri !== item.uri) return false;

  const now = performance.now();
  const progressMs = extrapolate(
    {
      progressMs: transport.positionMs,
      atMs: transport.atMs,
      isPlaying: transport.isPlaying,
      durationMs: item.duration_ms,
    },
    now,
  );
  nativeTransportPhase = null;
  anchor = {
    progressMs,
    atMs: now,
    isPlaying: transport.isPlaying,
    durationMs: item.duration_ms,
  };
  confirmed.anchor = { ...anchor };
  if (settledWebSelectionRequestId === requestId) settledWebSelectionRequestId = null;
  selectionConfirmationRetries = 0;
  set({
    item,
    pendingSelection: null,
    isPlaying: transport.isPlaying,
    progressMs,
    durationMs: item.duration_ms,
    error: null,
  });
  return true;
}

function deferPendingSelectionResolution(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  requestId: number,
  resolution: PendingSelectionResolution,
): void {
  // A real command failure takes precedence over a no-error supersession timer. Conversely, an
  // unrelated native event must not erase a failure that is already waiting for matching playback.
  if (resolution.kind === "superseded" && pendingSelectionResolutionTimer !== null) return;
  clearTimer(pendingSelectionResolutionTimer);
  const expectedRun = runId;
  pendingSelectionResolutionTimer = setTimeout(() => {
    pendingSelectionResolutionTimer = null;
    const current = get();
    if (runId !== expectedRun || current.pendingSelection?.requestId !== requestId) return;
    // A complete native takeover clears this request and cancels the timer. If the same request is
    // still pending, hydrate exact native transport from the catalog preview so missing metadata
    // cannot drop the renderer back to the branded idle state.
    if (promotePendingSelectionFromNativeTransport(set, get, requestId)) return;
    // Connection or a half-complete/unrelated event sequence is not confirmation.
    if (resolution.kind === "failed") fail(set, resolution.error);
    clearPendingSelection(set, get, requestId);
  }, NATIVE_TAKEOVER_GRACE_MS);
}

function nativeAccountMatches(): boolean {
  const status = native?.getStatus();
  return (
    webAccountId !== null &&
    status?.state === "ready" &&
    status.accountId === webAccountId
  );
}

function nativeConnectionActive(): boolean {
  return nativeSessionConnected || (native?.isActive?.() ?? false);
}

function nativeCanHandle(
  state: Pick<PlaybackSlice, "deviceId" | "sessionPresence">,
): boolean {
  const status = native?.getStatus();
  if (!nativeAccountMatches() || status?.state !== "ready") return false;
  return (
    (nativeConnectionActive() && state.deviceId === status.deviceId) ||
    (state.sessionPresence === "absent" && state.deviceId === null)
  );
}

async function withNative(
  state: Pick<PlaybackSlice, "deviceId" | "sessionPresence">,
  command: (engine: LibrespotEngine) => Promise<void>,
): Promise<boolean> {
  if (!nativeCanHandle(state) || native === null) return false;
  if (!isNativeDevice(state.deviceId)) await native.activate();
  await command(native);
  return true;
}

function itemFromNative(event: Extract<EngineEvent, { name: "track_changed" }>): PlayableItem {
  if (event.media_type === "episode") {
    return {
      id: event.id ?? event.uri.slice("spotify:episode:".length),
      name: event.title,
      uri: event.uri,
      duration_ms: event.duration_ms,
      ...(event.show !== undefined ? { show: { id: "", name: event.show } } : {}),
    };
  }

  return {
    id: event.media_type === "track" ? (event.id ?? null) : null,
    name: event.title,
    uri: event.uri,
    duration_ms: event.duration_ms,
    artists: event.artists,
    album: {
      id: "",
      name: event.album ?? "",
      uri: "",
      images: event.covers.map(({ url, width, height }) => ({ url, width, height })),
    },
    ...(event.media_type === "local" ? { is_local: true } : {}),
  };
}

function nativeDeviceId(): string | null {
  const status = native?.getStatus();
  return status?.state === "ready" ? status.deviceId : null;
}

function applyNativeEvent(
  set: (patch: Partial<PlaybackSlice>) => void,
  get: () => PlaybackSlice,
  event: EngineEvent,
): NativeSelectionEvidence | null {
  const now = performance.now();
  switch (event.name) {
    case "track_changed": {
      noteNative("playing", "progress");
      const item = itemFromNative(event);
      const transport = nativeTransportPhase?.uri === event.uri ? nativeTransportPhase : null;
      const progressMs =
        transport === null
          ? 0
          : extrapolate(
              {
                progressMs: transport.positionMs,
                atMs: transport.atMs,
                isPlaying: transport.isPlaying,
                durationMs: item.duration_ms,
              },
              now,
            );
      nativeTransportPhase = null;
      anchor = {
        progressMs,
        atMs: now,
        isPlaying: transport?.isPlaying ?? false,
        durationMs: item.duration_ms,
      };
      confirmed.anchor = { ...anchor };
      set({
        item,
        isPlaying: anchor.isPlaying,
        progressMs: anchor.progressMs,
        durationMs: item.duration_ms,
        deviceId: nativeDeviceId(),
        deviceName: DEVICE_NAME,
        sessionPresence: "present",
        error: null,
        ready: true,
      });
      return transport === null
        ? { kind: "metadata", uri: event.uri }
        : { kind: "complete", uri: event.uri };
    }
    case "playing":
    case "paused": {
      noteNative("playing", "progress");
      const isPlaying = event.name === "playing";
      const hasMetadata = get().item?.uri === event.uri;
      nativeTransportPhase = hasMetadata
        ? null
        : {
            uri: event.uri,
            isPlaying,
            positionMs: event.position_ms,
            atMs: now,
          };
      anchor = {
        ...anchor,
        progressMs: event.position_ms,
        atMs: now,
        isPlaying,
      };
      confirmed.anchor = { ...anchor };
      set({
        isPlaying,
        progressMs: event.position_ms,
        deviceId: nativeDeviceId(),
        deviceName: DEVICE_NAME,
        sessionPresence: "present",
        error: null,
        ready: true,
      });
      return hasMetadata
        ? { kind: "complete", uri: event.uri }
        : { kind: "transport", uri: event.uri };
    }
    case "seeked":
    case "position_changed":
      noteNative("progress");
      if (nativeTransportPhase?.uri === event.uri) {
        nativeTransportPhase = {
          ...nativeTransportPhase,
          positionMs: event.position_ms,
          atMs: now,
        };
      }
      anchor = { ...anchor, progressMs: event.position_ms, atMs: now };
      confirmed.anchor = {
        ...confirmed.anchor,
        progressMs: event.position_ms,
        atMs: now,
      };
      set({ progressMs: event.position_ms });
      return null;
    case "end_of_track":
      noteNative("playing");
      nativeTransportPhase = null;
      anchor = { ...materializeAnchor(anchor, now), isPlaying: false };
      confirmed.anchor = {
        ...materializeAnchor(confirmed.anchor, now),
        isPlaying: false,
      };
      set({ isPlaying: false, progressMs: anchor.progressMs });
      return null;
    case "stopped":
      noteNative("playing", "progress");
      nativeTransportPhase = null;
      anchor = { progressMs: 0, atMs: now, isPlaying: false, durationMs: 0 };
      confirmed.anchor = { ...anchor };
      set({
        item: null,
        isPlaying: false,
        progressMs: 0,
        durationMs: 0,
      });
      return null;
    case "volume_changed":
      noteNative("volume");
      confirmed.volumePercent = event.percent;
      set({ volumePercent: event.percent });
      return null;
    case "shuffle_changed":
      noteNative("shuffle");
      confirmed.shuffle = event.enabled;
      set({ shuffle: event.enabled });
      return null;
    case "repeat_changed": {
      noteNative("repeat");
      const repeat = event.track ? "track" : event.context ? "context" : "off";
      confirmed.repeat = repeat;
      set({ repeat });
      return null;
    }
    case "session_disconnected":
      noteNative("playing", "progress");
      nativeTransportPhase = null;
      anchor = { ...materializeAnchor(anchor, now), isPlaying: false };
      confirmed.anchor = { ...anchor };
      set({
        isPlaying: false,
        progressMs: anchor.progressMs,
        deviceId: null,
        deviceName: null,
        sessionPresence: "unknown",
      });
      return null;
    case "session_connected":
      set({
        deviceId: nativeDeviceId(),
        deviceName: DEVICE_NAME,
        sessionPresence: "present",
        ready: true,
      });
      return { kind: "connected" };
  }
}

export const usePlayback = create<PlaybackSlice>((set, get) => ({
  item: null,
  pendingSelection: null,
  isPlaying: false,
  shuffle: false,
  repeat: "off",
  volumePercent: null,
  deviceId: null,
  deviceName: null,
  sessionPresence: "unknown",
  progressMs: 0,
  durationMs: 0,
  error: null,
  ready: false,

  /** Begin adaptive, non-overlapping reconciliation. */
  start(player, engine, accountId = null, options = {}) {
    runId++;
    const thisRun = runId;
    api = player;
    native = engine ?? null;
    webAccountId = accountId;
    nativeRevision = 0;
    nativeSessionConnected = nativeAccountMatches() && (native?.isActive?.() ?? false);
    nativeTransportPhase = null;
    remoteTransferConfirmed = false;
    disconnectedNativeDeviceId = null;
    nativeDisconnectRetryCount = 0;
    webReconciliationSuspended = options.suspendWebReconciliation === true;
    webMutationRevision = 0;
    webMutationsInFlight = 0;
    latestRefreshRevision = -1;
    latestRefreshStartedAt = Number.NEGATIVE_INFINITY;
    webReadNotBefore = Number.NEGATIVE_INFINITY;
    selectionConfirmationRetries = 0;
    settledWebSelectionRequestId = null;
    const startingState = get();
    if (webReconciliationSuspended) {
      // No current-run source has authenticated retained playback state. Start empty while native
      // events remain live; account recovery will resume the Web lane when its sole probe succeeds.
      set({
        item: null,
        pendingSelection: null,
        isPlaying: false,
        shuffle: false,
        repeat: "off",
        volumePercent: null,
        deviceId: null,
        deviceName: null,
        sessionPresence: "unknown",
        progressMs: 0,
        durationMs: 0,
        error: null,
        ready: true,
      });
      anchor = {
        progressMs: 0,
        atMs: performance.now(),
        isPlaying: false,
        durationMs: 0,
      };
      confirmFromStore(get());
    } else {
      anchor = {
        progressMs: startingState.progressMs,
        atMs: performance.now(),
        isPlaying: startingState.isPlaying,
        durationMs: startingState.durationMs,
      };
      confirmFromStore(startingState);
      set({ sessionPresence: "unknown", ready: false, pendingSelection: null });
    }
    // An unresolved read belongs to the previous run. Its own identity guards keep it from
    // mutating this run, and the new run must issue an independent initial reconciliation.
    refreshController?.abort();
    refreshController = null;
    refreshInFlight = null;
    pollNotBefore = 0;
    clearTimer(pollTimer);
    clearTimer(reconcileTimer);
    clearTimer(errorClearTimer);
    clearTimer(pendingSelectionResolutionTimer);
    errorClearTimer = null;
    pendingSelectionResolutionTimer = null;
    errorRevision++;
    if (tickTimer !== null) clearInterval(tickTimer);
    unsubscribeNative?.();
    unsubscribeNative =
      native?.onEvent((event) => {
        if (runId !== thisRun) return;
        // The Web API and librespot authenticate independently. Never let events from a cached
        // native login mutate or control the currently authenticated Web account.
        if (!nativeAccountMatches()) return;

        if (event.name === "session_disconnected") {
          const disconnectedDeviceId = nativeDeviceId();
          nativeSessionConnected = false;
          disconnectedNativeDeviceId = disconnectedDeviceId;
          nativeDisconnectRetryCount = 0;
          nativeRevision++;
          refreshController?.abort();
          // A delayed disconnect from a transfer must not erase a remote device already confirmed
          // by the picker. Only clear state that still belongs to this native receiver.
          if (
            disconnectedDeviceId !== null &&
            get().deviceId === disconnectedDeviceId
          ) {
            applyNativeEvent(set, get, event);
          }
          reconcileCompletedWebMutation(get);
          return;
        }

        // Disconnect is handled above so it always clears authoritative session presence. Other
        // residual events cannot reclaim playback until a fresh connection proves a local session.
        if (remoteTransferConfirmed && event.name !== "session_connected") return;
        if (event.name === "session_connected") remoteTransferConfirmed = false;

        const establishesLocalPlayback =
          event.name === "session_connected" ||
          event.name === "track_changed" ||
          event.name === "playing" ||
          event.name === "paused";
        if (establishesLocalPlayback) {
          nativeSessionConnected = true;
          disconnectedNativeDeviceId = null;
          nativeDisconnectRetryCount = 0;
        }
        if (!establishesLocalPlayback && !isNativeDevice(get().deviceId)) {
          // Mixer/configuration events can be emitted while the receiver is merely available.
          // They must not overwrite state belonging to an active external device.
          return;
        }

        nativeRevision++;
        refreshController?.abort();
        const selectionEvidence = applyNativeEvent(set, get, event);
        updatePendingWebSelectionFromNative(set, get, selectionEvidence);
        clearTimer(pollTimer);
        clearTimer(reconcileTimer);
        pollTimer = null;
        reconcileTimer = null;
      }) ?? null;

    // A synchronously replayed native snapshot is already newer and more precise than the public
    // player endpoint. Do not immediately spend quota or let a stale Web snapshot overwrite it.
    if (
      !webReconciliationSuspended &&
      (nativeRevision === 0 || !isNativeDevice(get().deviceId))
    ) {
      void get().refresh();
    }
    tickTimer = setInterval(() => {
      const next = extrapolate(anchor, performance.now());
      // Only write when the rendered second changes, so we don't re-render 4x/sec for nothing.
      if (Math.floor(next / 1000) !== Math.floor(get().progressMs / 1000)) {
        set({ progressMs: next });
      }
    }, TICK_INTERVAL_MS);

    return () => {
      runId++;
      clearTimer(pollTimer);
      clearTimer(reconcileTimer);
      clearTimer(errorClearTimer);
      clearTimer(pendingSelectionResolutionTimer);
      pollTimer = null;
      reconcileTimer = null;
      errorClearTimer = null;
      pendingSelectionResolutionTimer = null;
      settledWebSelectionRequestId = null;
      errorRevision++;
      webMutationsInFlight = 0;
      if (tickTimer !== null) clearInterval(tickTimer);
      tickTimer = null;
      unsubscribeNative?.();
      unsubscribeNative = null;
      refreshController?.abort();
      refreshController = null;
      refreshInFlight = null;
      api = null;
      native = null;
      webAccountId = null;
      nativeSessionConnected = false;
      nativeTransportPhase = null;
      remoteTransferConfirmed = false;
      disconnectedNativeDeviceId = null;
      nativeDisconnectRetryCount = 0;
      webReconciliationSuspended = false;
    };
  },

  async refresh(priority = "background") {
    if (refreshInFlight !== null) return await refreshInFlight;
    if (webReconciliationSuspended) return;
    const currentApi = api;
    const currentRun = runId;
    const nativeRevisionAtStart = nativeRevision;
    const webRevisionAtStart = webMutationRevision;
    const refreshStartedAt = performance.now();
    if (currentApi === null) return;
    latestRefreshRevision = webRevisionAtStart;
    latestRefreshStartedAt = refreshStartedAt;
    const controller = new AbortController();
    refreshController = controller;

    const pending = (async () => {
      try {
        const state = await currentApi.state(priority, controller.signal);
        if (api !== currentApi || runId !== currentRun) return;
        // Native events are newer and authoritative for the local player. Do not let an older Web
        // API response overwrite them when activation and reconciliation cross in flight.
        if (
          nativeRevision !== nativeRevisionAtStart ||
          webMutationRevision !== webRevisionAtStart ||
          refreshStartedAt < webReadNotBefore ||
          webMutationsInFlight > 0
        ) {
          return;
        }
        if (
          disconnectedNativeDeviceId !== null &&
          state?.device?.id === disconnectedNativeDeviceId &&
          !nativeConnectionActive()
        ) {
          // Connect is authoritative for its own receiver. Give Spotify one additional bounded
          // settle window, then fall back to the normal idle poll cadence if Web state remains stale.
          if (nativeDisconnectRetryCount === 0) {
            nativeDisconnectRetryCount++;
            reconcileCompletedWebMutation(get, 2_000);
          }
          return;
        }
        disconnectedNativeDeviceId = null;
        nativeDisconnectRetryCount = 0;
        pollNotBefore = 0;
        const next = applyState(state);
        const pendingSelection = get().pendingSelection;
        const selectionMatches = selectionMatchesState(pendingSelection, state);
        const selectionNeedsFollowUp =
          pendingSelection?.requiresFollowUp === true &&
          selectionConfirmationRetries === 0;
        if (pendingSelection !== null && selectionMatches && !selectionNeedsFollowUp) {
          resetPendingSelectionTracking(pendingSelection.requestId);
          next.pendingSelection = null;
        } else if (pendingSelection !== null) {
          if (selectionConfirmationRetries === 0) {
            selectionConfirmationRetries++;
            reconcileCompletedWebMutation(get, SELECTION_RECONCILE_RETRY_MS);
          } else {
            // The second post-command snapshot is authoritative even if Spotify chose another
            // item, played an ad, or declined to create a session.
            resetPendingSelectionTracking(pendingSelection.requestId);
            next.pendingSelection = null;
          }
        }
        const currentError = get().error;
        if (errorIsStale(currentError)) {
          clearTimer(errorClearTimer);
          errorClearTimer = null;
          set({ ...next, error: null });
        } else {
          set(next);
          if (currentError !== null) {
            scheduleErrorClear(
              set,
              currentError,
              errorRevision,
              ERROR_LINGER_MS - (performance.now() - errorAt),
            );
          }
        }
      } catch (err) {
        if (api !== currentApi || runId !== currentRun) return;
        if (
          controller.signal.aborted ||
          nativeRevision !== nativeRevisionAtStart ||
          webMutationRevision !== webRevisionAtStart ||
          refreshStartedAt < webReadNotBefore ||
          webMutationsInFlight > 0
        ) {
          return;
        }
        fail(set, err);
        const pendingSelection = get().pendingSelection;
        if (pendingSelection !== null) resetPendingSelectionTracking(pendingSelection.requestId);
        set({ ready: true, pendingSelection: null });
      }
    })();
    refreshInFlight = pending;
    try {
      await pending;
    } finally {
      if (refreshInFlight === pending) refreshInFlight = null;
      if (refreshController === controller) refreshController = null;
      if (api === currentApi && runId === currentRun) schedulePoll(get, currentRun);
    }
  },

  suspendWebReconciliation() {
    webReconciliationSuspended = true;
    clearTimer(pollTimer);
    clearTimer(reconcileTimer);
    pollTimer = null;
    reconcileTimer = null;
    refreshController?.abort();
  },

  async resumeWebReconciliation() {
    webReconciliationSuspended = false;
    const pending = refreshInFlight;
    if (pending !== null) await pending;
    if (
      webReconciliationSuspended ||
      api === null ||
      // `isNativeDevice` also requires authoritative current connection activity. A disconnect
      // therefore resumes Web reconciliation even though it increments the current-run revision.
      (nativeRevision > 0 && isNativeDevice(get().deviceId))
    ) {
      return;
    }
    if (performance.now() < webReadNotBefore) {
      scheduleReconciliation(get, webMutationRevision, webReadNotBefore);
      return;
    }
    await get().refresh("foreground");
  },

  reconcileSoon() {
    if (
      api === null ||
      webReconciliationSuspended ||
      isNativeDevice(get().deviceId)
    ) {
      return;
    }
    reconcileCompletedWebMutation(get);
  },

  confirmDeviceTransfer(deviceId, deviceName) {
    remoteTransferConfirmed = true;
    nativeTransportPhase = null;
    set({
      deviceId,
      deviceName,
      sessionPresence: "present",
      ready: true,
    });
    get().reconcileSoon();
  },

  async playSelection(options, preview) {
    if (api === null) return;
    clearTimer(pendingSelectionResolutionTimer);
    pendingSelectionResolutionTimer = null;
    settledWebSelectionRequestId = null;
    // A new selection is a new play instance even when it repeats the same URI. Never let an
    // unpaired phase from the previous instance satisfy this transition.
    nativeTransportPhase = null;
    const requestId = ++selectionRequestId;
    selectionConfirmationRetries = 0;
    const state = get();
    const routeNative = nativeCanHandle(state);
    const confirmation = selectionConfirmationFor(options, preview);
    set({
      pendingSelection: {
        requestId,
        label: preview?.label ?? "selection",
        item: preview?.item ?? null,
        confirmation,
        requiresFollowUp: selectionRequiresFollowUp(confirmation, state),
        lane: routeNative ? "native" : "web",
      },
      error: null,
    });
    let webMutation = routeNative ? null : beginWebMutation();
    try {
      if (
        routeNative &&
        (await withNative(state, async (engine) => {
          await engine.load({
            ...options,
            shuffle: state.shuffle,
            repeat: state.repeat,
          });
        }))
      ) {
        // Keep the transition through metadata events: native load resolves only after the player
        // confirms it began, including when Spotify substitutes another playable item.
        clearPendingSelection(set, get, requestId);
        return;
      }
      // Native availability can change between route selection and command dispatch. Once this
      // request falls back, only Web reconciliation or an authoritative native takeover owns it.
      movePendingSelectionToWeb(set, get, requestId);
      webMutation ??= beginWebMutation();
      await api.play({
        ...options,
        ...(state.deviceId !== null ? { deviceId: state.deviceId } : {}),
      });
      settlePendingWebSelection(set, get, requestId);
    } catch (err) {
      // A superseded request owns neither the visible pending state nor its error surface.
      const current = get();
      if (current.pendingSelection?.requestId === requestId) {
        // A new native connection can make the in-flight Web command stale, but connection alone
        // does not prove playback. Preserve the preview briefly; the exact native handshake cancels
        // this failure, while the bounded timer surfaces an incomplete takeover.
        if (current.pendingSelection.lane === "web" && isNativeDevice(current.deviceId)) {
          deferPendingSelectionResolution(set, get, requestId, {
            kind: "failed",
            error: err,
          });
          return;
        }
        fail(set, err, isNativeDevice(current.deviceId) ? "transient" : "until-success");
        clearPendingSelection(set, get, requestId);
      }
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  /**
   * Optimistically flip the play state so the UI responds immediately, then reconcile.
   * A failed command restores the last authoritative value unless a newer command or native event
   * superseded it.
   */
  async togglePlay() {
    if (api === null) return;
    const { isPlaying, deviceId } = get();
    const target = !isPlaying;
    const progressRevision = fieldRevision("progress");
    const guard = beginOptimistic("playing");
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    set({ isPlaying: target });
    anchor = {
      ...anchor,
      progressMs: extrapolate(anchor, performance.now()),
      atMs: performance.now(),
      isPlaying: target,
    };
    try {
      try {
        const handled =
          routeNative &&
          (await withNative(get(), (engine) => (isPlaying ? engine.pause() : engine.play())));
        if (!handled) {
          webMutation ??= beginWebMutation();
          if (isPlaying) await api.pause(deviceId ?? undefined);
          else await api.play({ ...(deviceId !== null ? { deviceId } : {}) });
        }
      } catch (err) {
        const currentDeviceId = get().deviceId;
        if (
          !isPlaying &&
          err instanceof NativePlaybackUnavailableError &&
          currentDeviceId !== null &&
          isNativeDevice(currentDeviceId)
        ) {
          // librespot's local Spirc::play is deliberately a no-op from Stopped, while a targeted
          // Connect Resume reloads that state. Spend one Web mutation only for this exceptional path.
          webMutation ??= beginWebMutation();
          await api.play({ deviceId: currentDeviceId });
        } else {
          throw err;
        }
      }
      if (webMutation !== null) {
        confirmOptimisticSuccess(guard, () => {
          const now = performance.now();
          confirmed.anchor = {
            ...materializeAnchor(confirmed.anchor, now),
            atMs: now,
            isPlaying: target,
          };
        });
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
      if (mayRollback(guard) && get().isPlaying === target) {
        const now = performance.now();
        anchor = revisionMatches("progress", progressRevision)
          ? materializeAnchor(confirmed.anchor, now)
          : {
              ...anchor,
              atMs: now,
              isPlaying: confirmed.anchor.isPlaying,
            };
        set({
          isPlaying: confirmed.anchor.isPlaying,
          progressMs: anchor.progressMs,
        });
      }
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  async next() {
    if (api === null) return;
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    try {
      const handled = routeNative && (await withNative(get(), (engine) => engine.next()));
      if (!handled) {
        webMutation ??= beginWebMutation();
        await api.next(get().deviceId ?? undefined);
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  async previous() {
    if (api === null) return;
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    try {
      const handled = routeNative && (await withNative(get(), (engine) => engine.previous()));
      if (!handled) {
        webMutation ??= beginWebMutation();
        await api.previous(get().deviceId ?? undefined);
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  async seekBy(deltaMs) {
    if (api === null) return;
    const { durationMs, deviceId } = get();
    const target = Math.min(durationMs, Math.max(0, extrapolate(anchor, performance.now()) + deltaMs));
    const guard = beginOptimistic("progress");
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    anchor = { ...anchor, progressMs: target, atMs: performance.now() };
    set({ progressMs: target });
    try {
      const handled = routeNative && (await withNative(get(), (engine) => engine.seek(target)));
      if (!handled) {
        webMutation ??= beginWebMutation();
        await api.seek(target, deviceId ?? undefined);
      }
      if (webMutation !== null) {
        confirmOptimisticSuccess(guard, () => {
          const now = performance.now();
          confirmed.anchor = {
            ...materializeAnchor(confirmed.anchor, now),
            progressMs: target,
            atMs: now,
          };
        });
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
      if (mayRollback(guard)) {
        const restored = materializeAnchor(confirmed.anchor);
        anchor = {
          ...anchor,
          progressMs: restored.progressMs,
          atMs: restored.atMs,
        };
        set({ progressMs: restored.progressMs });
      }
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  async adjustVolume(delta) {
    if (api === null) return;
    const { volumePercent, deviceId } = get();
    if (volumePercent === null) return;
    const target = Math.min(100, Math.max(0, volumePercent + delta));
    if (target === volumePercent) return;
    const guard = beginOptimistic("volume");
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    set({ volumePercent: target });
    try {
      const handled =
        routeNative && (await withNative(get(), (engine) => engine.setVolume(target)));
      if (!handled) {
        webMutation ??= beginWebMutation();
        await api.setVolume(target, deviceId ?? undefined);
      }
      if (webMutation !== null) {
        confirmOptimisticSuccess(guard, () => {
          confirmed.volumePercent = target;
        });
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
      if (mayRollback(guard) && get().volumePercent === target) {
        set({ volumePercent: confirmed.volumePercent });
      }
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  async toggleShuffle() {
    if (api === null) return;
    const { shuffle, deviceId } = get();
    const target = !shuffle;
    const guard = beginOptimistic("shuffle");
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    set({ shuffle: target });
    try {
      const handled =
        routeNative && (await withNative(get(), (engine) => engine.setShuffle(target)));
      if (!handled) {
        webMutation ??= beginWebMutation();
        await api.setShuffle(target, deviceId ?? undefined);
      }
      if (webMutation !== null) {
        confirmOptimisticSuccess(guard, () => {
          confirmed.shuffle = target;
        });
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
      if (mayRollback(guard) && get().shuffle === target) {
        set({ shuffle: confirmed.shuffle });
      }
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },

  async cycleRepeat() {
    if (api === null) return;
    const { repeat, deviceId } = get();
    const mode = nextRepeatState(repeat);
    const guard = beginOptimistic("repeat");
    const routeNative = nativeCanHandle(get());
    let webMutation = routeNative ? null : beginWebMutation();
    set({ repeat: mode });
    try {
      const handled =
        routeNative && (await withNative(get(), (engine) => engine.setRepeat(mode)));
      if (!handled) {
        webMutation ??= beginWebMutation();
        await api.setRepeat(mode, deviceId ?? undefined);
      }
      if (webMutation !== null) {
        confirmOptimisticSuccess(guard, () => {
          confirmed.repeat = mode;
        });
      }
    } catch (err) {
      fail(set, err, isNativeDevice(get().deviceId) ? "transient" : "until-success");
      if (mayRollback(guard) && get().repeat === mode) {
        set({ repeat: confirmed.repeat });
      }
    } finally {
      if (webMutation !== null) finishWebMutation(get, webMutation);
    }
  },
}));
