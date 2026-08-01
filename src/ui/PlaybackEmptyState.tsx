import { BrandSplash } from "./Brand.tsx";

export function playbackEmptyStateText(ready: boolean, canSearch: boolean): string {
  if (!ready) return "LOADING…";
  return canSearch
    ? "NOTHING PLAYING — press / to find something"
    : "WEB API LIMITED — press r to retry account verification";
}

export function PlaybackEmptyState({
  ready,
  canSearch,
  width,
  height,
}: {
  ready: boolean;
  canSearch: boolean;
  width: number;
  height: number;
}) {
  return (
    <BrandSplash
      message={playbackEmptyStateText(ready, canSearch)}
      width={width}
      height={height}
    />
  );
}
