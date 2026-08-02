import type { MouseEvent } from "@opentui/core";
import { useEffect } from "react";
import { artistLine, type PlayableItem } from "../api/types.ts";
import { formatDuration } from "../store/progress.ts";
import { useQueue } from "../store/queue.ts";
import {
  Overlay,
  OverlayTitle,
  overlayInnerWidth,
  overlayListHeight,
  scrollSteps,
} from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Rows the now-playing block adds above the list: its header, its row, and a spacer. */
const NOW_PLAYING_ROWS = 3;

/** The `UP NEXT` header row, which sits inside the list area but is not an item. */
const UP_NEXT_HEADER_ROWS = 1;

/**
 * Rows available to up-next items.
 *
 * Shared with the keyboard handler so paging and clamping move by exactly the rows on screen; the
 * two drifting apart is how a page ends up scrolling one row short or past the end.
 */
export function queueListHeight(
  height: number,
  state: { nowPlaying: PlayableItem | null; upNext: PlayableItem[] },
): number {
  return overlayListHeight(
    height,
    (state.nowPlaying === null ? 0 : NOW_PLAYING_ROWS) +
      (state.upNext.length === 0 ? 0 : UP_NEXT_HEADER_ROWS),
  );
}

function ItemRow({
  item,
  index,
  width,
  dim,
}: {
  item: PlayableItem;
  index: string;
  width: number;
  dim?: boolean;
}) {
  const nameWidth = Math.max(12, Math.min(46, Math.floor(width * 0.5)));
  const detailWidth = Math.max(0, Math.min(28, width - nameWidth - 12));

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.faint}>{index.padStart(3)}</text>
      <text fg={dim === true ? theme.muted : theme.text}>
        {truncate(item.name, nameWidth).padEnd(nameWidth)}
      </text>
      <text fg={theme.label}>{truncate(artistLine(item), detailWidth).padEnd(detailWidth)}</text>
      <text fg={theme.label}>{formatDuration(item.duration_ms).padStart(6)}</text>
    </box>
  );
}

/**
 * Up-next list, overlaid on the dimmed cover.
 *
 * Read-only by necessity: Spotify exposes the queue and lets you append to it, but gives no way to
 * reorder or remove, so there is nothing to select and no highlight. Scrolling is therefore a plain
 * offset rather than a followed selection.
 */
export function QueueView({ width, height }: { width: number; height: number }) {
  const nowPlaying = useQueue((s) => s.nowPlaying);
  const upNext = useQueue((s) => s.upNext);
  const loading = useQueue((s) => s.loading);
  const error = useQueue((s) => s.error);
  const offset = useQueue((s) => s.offset);
  const scrollBy = useQueue((s) => s.scrollBy);
  const clampOffset = useQueue((s) => s.clampOffset);

  const inner = overlayInnerWidth(width);
  const listHeight = queueListHeight(height, { nowPlaying, upNext });
  const scrollable = upNext.length > listHeight;

  // Clamping lives in the store, which cannot know how many rows the terminal offers until the view
  // has laid out for this height. Runs after a refresh shrinks the queue and after a resize.
  useEffect(() => {
    clampOffset(listHeight);
  }, [upNext.length, listHeight, clampOffset]);

  const handleMouseScroll = (event: MouseEvent) => {
    const rows = scrollSteps(event);
    if (rows === null || !scrollable) return;
    scrollBy(rows, listHeight);
    event.stopPropagation();
  };

  const visible = upNext.slice(offset, offset + listHeight);

  const status = (() => {
    if (error !== null) return error;
    if (loading) return "loading…";
    if (nowPlaying === null && upNext.length === 0) return "nothing playing, nothing queued";
    if (upNext.length === 0) return "nothing queued";
    if (scrollable) {
      return `${offset + 1}–${Math.min(upNext.length, offset + listHeight)} of ${upNext.length} up next`;
    }
    return `${upNext.length} up next`;
  })();

  const hints = scrollable
    ? "↑↓ scroll · r refresh · esc close"
    : "r refresh · esc close";

  return (
    <Overlay
      width={width}
      height={height}
      header={<OverlayTitle glyph="≡" title="QUEUE" />}
      status={status}
      hints={hints}
      isError={error !== null}
      onMouseScroll={handleMouseScroll}
    >
      {nowPlaying !== null ? (
        <box flexDirection="column">
          <text fg={theme.label}>
            <strong>NOW PLAYING</strong>
          </text>
          <ItemRow item={nowPlaying} index="▶" width={inner} />
        </box>
      ) : null}

      <box flexDirection="column" marginTop={nowPlaying === null ? 0 : 1}>
        {upNext.length > 0 ? (
          <text fg={theme.label}>
            <strong>UP NEXT</strong>
          </text>
        ) : null}
        {visible.map((item, index) => (
          <ItemRow
            key={`${item.uri}-${offset + index}`}
            item={item}
            index={String(offset + index + 1)}
            width={inner}
            dim
          />
        ))}
      </box>
    </Overlay>
  );
}
