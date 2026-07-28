import { artistLine, type PlayableItem } from "../api/types.ts";
import { useActions } from "../store/actions.ts";
import { Overlay, OverlayTitle, overlayInnerWidth, overlayListHeight } from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Width of the verb column, so the details line up. */
const LABEL_WIDTH = 14;

/**
 * Actions on the playing track.
 *
 * A menu rather than a key per destination: album and artist are two of many verbs a track will
 * eventually have, and binding each to its own letter is how a keymap becomes unlearnable.
 */
export function ActionsMenu({
  width,
  height,
  item,
}: {
  width: number;
  height: number;
  item: PlayableItem;
}) {
  const entries = useActions((s) => s.entries);
  const selected = useActions((s) => s.selected);

  const inner = overlayInnerWidth(width);
  const listHeight = overlayListHeight(height);

  return (
    <Overlay
      width={width}
      height={height}
      header={<OverlayTitle glyph="◈" title={truncate(item.name.toUpperCase(), inner - 4)} />}
      status={artistLine(item)}
      hints="↑↓ move · ↵ open · esc close"
    >
      {entries.slice(0, listHeight).map((entry, index) => (
        <box key={`${entry.label}-${entry.drill.id}`} flexDirection="row" gap={1}>
          <text fg={index === selected ? theme.accent : theme.faint}>
            {index === selected ? "▌" : " "}
          </text>
          <text fg={index === selected ? theme.text : theme.muted}>
            {entry.label.padEnd(LABEL_WIDTH)}
          </text>
          <text fg={theme.label}>{truncate(entry.detail, inner - LABEL_WIDTH - 4)}</text>
        </box>
      ))}
    </Overlay>
  );
}
