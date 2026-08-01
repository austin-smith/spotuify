import type { PlayableItem, RepeatState } from "../api/types.ts";
import type { PendingPlaybackSelection } from "../store/playback.ts";
import { Hud } from "./Hud.tsx";
import { PlaybackEmptyState } from "./PlaybackEmptyState.tsx";
import { PlaybackStartingState } from "./PlaybackStartingState.tsx";

export function playbackDisplayItem(
  item: PlayableItem | null,
  pendingSelection: PendingPlaybackSelection | null,
): PlayableItem | null {
  return item ?? pendingSelection?.item ?? null;
}

/** The mutually exclusive playback surfaces behind overlays. */
export function PlaybackStage({
  item,
  pendingSelection,
  progressMs,
  durationMs,
  isPlaying,
  shuffle,
  repeat,
  volumePercent,
  deviceName,
  isLocalDevice,
  ready,
  canSearch,
  overlayOpen,
  width,
  height,
}: {
  item: PlayableItem | null;
  pendingSelection: PendingPlaybackSelection | null;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatState;
  volumePercent: number | null;
  deviceName: string | null;
  isLocalDevice: boolean;
  ready: boolean;
  canSearch: boolean;
  overlayOpen: boolean;
  width: number;
  height: number;
}) {
  if (overlayOpen) return null;

  const displayItem = playbackDisplayItem(item, pendingSelection);
  if (displayItem !== null) {
    const starting =
      pendingSelection !== null &&
      (item === null ||
        (pendingSelection.item !== null && pendingSelection.item.uri === item.uri));
    return (
      <Hud
        item={displayItem}
        progressMs={starting ? 0 : progressMs}
        durationMs={starting ? displayItem.duration_ms : durationMs}
        isPlaying={starting ? false : isPlaying}
        shuffle={shuffle}
        repeat={repeat}
        volumePercent={volumePercent}
        deviceName={deviceName}
        isLocalDevice={isLocalDevice}
        starting={starting}
        width={width}
        height={height}
      />
    );
  }

  if (pendingSelection !== null) {
    return (
      <PlaybackStartingState
        label={pendingSelection.label}
        width={width}
        height={height}
      />
    );
  }

  return (
    <PlaybackEmptyState
      ready={ready}
      canSearch={canSearch}
      width={width}
      height={height}
    />
  );
}
