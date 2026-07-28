/**
 * Local playback-progress extrapolation.
 *
 * Polling `/me/player` often enough for a smooth progress bar would burn the rate limit, so we poll
 * infrequently and advance progress locally from a monotonic clock between polls.
 */

export interface ProgressAnchor {
  /** `progress_ms` as reported by the last poll. */
  progressMs: number;
  /** `performance.now()` at the moment that poll was applied. */
  atMs: number;
  isPlaying: boolean;
  durationMs: number;
}

/**
 * Progress at time `nowMs`, clamped to the track length.
 *
 * A monotonic clock is required: wall-clock adjustments (NTP, DST, sleep/wake) would otherwise make
 * progress jump backwards or past the end of the track.
 */
export function extrapolate(anchor: ProgressAnchor, nowMs: number): number {
  if (!anchor.isPlaying) return clamp(anchor.progressMs, anchor.durationMs);
  const elapsed = Math.max(0, nowMs - anchor.atMs);
  return clamp(anchor.progressMs + elapsed, anchor.durationMs);
}

function clamp(value: number, durationMs: number): number {
  if (durationMs <= 0) return Math.max(0, value);
  return Math.min(Math.max(0, value), durationMs);
}

/** `m:ss`, matching how the Spotify clients render durations. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Solid-block bar, tracker style. */
export const BAR_FILL = "█";
export const BAR_EMPTY = "░";

/** A block progress bar exactly `width` cells wide. */
export function progressBar(
  progressMs: number,
  durationMs: number,
  width: number,
  fill: string = BAR_FILL,
  empty: string = BAR_EMPTY,
): string {
  if (width <= 0) return "";
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, progressMs / durationMs)) : 0;
  const filled = Math.round(ratio * width);
  return fill.repeat(filled) + empty.repeat(width - filled);
}

/** Discrete meter for volume and similar 0..1 values. */
export function meter(value: number, max: number, width: number): string {
  if (width <= 0 || max <= 0) return "";
  const filled = Math.round(Math.min(1, Math.max(0, value / max)) * width);
  return BAR_FILL.repeat(filled) + BAR_EMPTY.repeat(width - filled);
}
