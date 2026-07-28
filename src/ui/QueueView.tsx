import { artistLine, type PlayableItem } from "../api/types.ts";
import { formatDuration } from "../store/progress.ts";
import { useQueue } from "../store/queue.ts";
import { theme } from "./theme.ts";

/** Rows above and below the list: title, rule, now-playing block, and the footer hint. */
const CHROME_ROWS = 10;

function truncate(value: string, max: number): string {
  if (max <= 1) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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
 * reorder or remove, so there is nothing to select and no highlight.
 */
export function QueueView({ width, height }: { width: number; height: number }) {
  const nowPlaying = useQueue((s) => s.nowPlaying);
  const upNext = useQueue((s) => s.upNext);
  const loading = useQueue((s) => s.loading);
  const error = useQueue((s) => s.error);

  const inner = width - 8;
  const listHeight = Math.max(3, height - CHROME_ROWS);

  const status = (() => {
    if (error !== null) return error;
    if (loading) return "loading…";
    if (nowPlaying === null && upNext.length === 0) return "nothing playing, nothing queued";
    return upNext.length === 0 ? "nothing queued" : `${upNext.length} up next`;
  })();

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={10}
      flexDirection="column"
      paddingX={4}
      paddingY={2}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.accent}>
          <strong>≡</strong>
        </text>
        <text fg={theme.text}>
          <strong>QUEUE</strong>
        </text>
      </box>

      <box marginTop={1}>
        <text fg={theme.faint}>{"─".repeat(Math.max(0, inner))}</text>
      </box>

      {nowPlaying !== null ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.label}>
            <strong>NOW PLAYING</strong>
          </text>
          <ItemRow item={nowPlaying} index="▶" width={inner} />
        </box>
      ) : null}

      <box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
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

      <box flexDirection="row" justifyContent="space-between">
        <text fg={error !== null ? theme.error : theme.label}>{truncate(status, inner - 24)}</text>
        <text fg={theme.faint}>r refresh · esc close</text>
      </box>
    </box>
  );
}
