import { artistLine, type PlayableItem } from "../api/types.ts";
import { formatDuration } from "../store/progress.ts";
import { useQueue } from "../store/queue.ts";
import { Overlay, OverlayTitle, overlayInnerWidth, overlayListHeight } from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Rows the now-playing block adds above the list: its header, its row, and a spacer. */
const NOW_PLAYING_ROWS = 3;

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
 * reorder or remove, so there is nothing to select and no highlight.
 */
export function QueueView({ width, height }: { width: number; height: number }) {
  const nowPlaying = useQueue((s) => s.nowPlaying);
  const upNext = useQueue((s) => s.upNext);
  const loading = useQueue((s) => s.loading);
  const error = useQueue((s) => s.error);

  const inner = overlayInnerWidth(width);
  const listHeight = overlayListHeight(height, nowPlaying === null ? 0 : NOW_PLAYING_ROWS);

  const status = (() => {
    if (error !== null) return error;
    if (loading) return "loading…";
    if (nowPlaying === null && upNext.length === 0) return "nothing playing, nothing queued";
    return upNext.length === 0 ? "nothing queued" : `${upNext.length} up next`;
  })();

  return (
    <Overlay
      width={width}
      height={height}
      header={<OverlayTitle glyph="≡" title="QUEUE" />}
      status={status}
      hints="r refresh · esc close"
      isError={error !== null}
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
        {upNext.slice(0, listHeight).map((item, index) => (
          <ItemRow
            key={`${item.uri}-${index}`}
            item={item}
            index={String(index + 1)}
            width={inner}
            dim
          />
        ))}
      </box>
    </Overlay>
  );
}
