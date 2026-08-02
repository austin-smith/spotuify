import { BrandSplash } from "./Brand.tsx";

/** One message from launch to first playback state; the internal stages are not worth naming. */
export const STARTUP_MESSAGE = "CONNECTING TO SPOTIFY…";

/** Launches that settle faster than this never show loading text at all. */
export const STARTUP_MESSAGE_DELAY_MS = 400;

export function playbackEmptyStateText(
  ready: boolean,
  canSearch: boolean,
  startupMessageVisible: boolean,
): string {
  // "" still reserves the message row, so the wordmark holds position when text appears.
  if (!ready) return startupMessageVisible ? STARTUP_MESSAGE : "";
  return canSearch
    ? "NOTHING PLAYING — press / to find something"
    : "WEB API LIMITED — press r to retry account verification";
}

export function PlaybackEmptyState({
  ready,
  canSearch,
  startupMessageVisible,
  width,
  height,
}: {
  ready: boolean;
  canSearch: boolean;
  startupMessageVisible: boolean;
  width: number;
  height: number;
}) {
  return (
    <BrandSplash
      message={playbackEmptyStateText(ready, canSearch, startupMessageVisible)}
      width={width}
      height={height}
    />
  );
}
