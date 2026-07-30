import { useActions } from "../store/actions.ts";
import { listWindowStart } from "../store/rows.ts";
import { Overlay, OverlayTitle, overlayInnerWidth, overlayListHeight } from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Width of the verb column, so every detail begins at the same cell. */
const LABEL_WIDTH = 20;

/** Contextual verbs for either the playing item or a highlighted palette item. */
export function ActionsMenu({ width, height }: { width: number; height: number }) {
  const target = useActions((s) => s.target);
  const entries = useActions((s) => s.entries);
  const selected = useActions((s) => s.selected);
  const savedLoading = useActions((s) => s.savedLoading);
  const busy = useActions((s) => s.busy);
  const error = useActions((s) => s.error);

  if (target === null) return null;

  const inner = overlayInnerWidth(width);
  const listHeight = overlayListHeight(height);
  const start = listWindowStart(entries.length, selected, listHeight);
  const visible = entries.slice(start, start + listHeight);
  const status =
    error ?? (busy ? "updating spotify…" : savedLoading ? "checking liked state…" : "actions");

  return (
    <Overlay
      width={width}
      height={height}
      header={<OverlayTitle glyph="◈" title={truncate(target.name.toUpperCase(), inner - 4)} />}
      status={status}
      isError={error !== null}
      hints="↑↓ move · ↵ choose · esc close"
    >
      {visible.map((entry, offset) => {
        const index = start + offset;
        const active = index === selected;
        return (
          <box key={entry.id} flexDirection="row" gap={1}>
            <text fg={active ? theme.accent : theme.faint}>{active ? "▌" : " "}</text>
            <text
              fg={
                entry.disabled
                  ? theme.faint
                  : active
                    ? theme.text
                    : theme.muted
              }
            >
              {entry.label.padEnd(LABEL_WIDTH)}
            </text>
            <text fg={entry.disabled ? theme.faint : theme.label}>
              {truncate(entry.detail, inner - LABEL_WIDTH - 4)}
            </text>
          </box>
        );
      })}
      {entries.length === 0 ? <text fg={theme.label}>no actions available</text> : null}
    </Overlay>
  );
}
