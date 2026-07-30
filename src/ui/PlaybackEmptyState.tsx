import { theme } from "./theme.ts";

export function playbackEmptyStateText(ready: boolean, canSearch: boolean): string {
  if (!ready) return "LOADING…";
  return canSearch
    ? "NOTHING PLAYING — press / to find something"
    : "WEB API LIMITED — press r to retry account verification";
}

export function PlaybackEmptyState({
  ready,
  canSearch,
  height,
}: {
  ready: boolean;
  canSearch: boolean;
  height: number;
}) {
  return (
    <box position="absolute" left={2} top={Math.floor(height / 2)} zIndex={2}>
      <text fg={theme.muted}>{playbackEmptyStateText(ready, canSearch)}</text>
    </box>
  );
}
