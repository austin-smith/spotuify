import { barFor, type Binding } from "./keys.ts";
import { theme } from "./theme.ts";

const GAP = 2;

/**
 * As many whole hints as fit the width.
 *
 * Labels are never dropped. An earlier version hid every label once the strip overflowed, which left
 * a row of bare letters nobody could read.
 */
export function fitHints(hints: Binding[], width: number): Binding[] {
  const budget = width - 2;
  const kept: Binding[] = [];
  let used = 0;

  for (const hint of hints) {
    const cost = hint.key.length + 1 + hint.action.length + (kept.length > 0 ? GAP : 0);
    if (used + cost > budget) break;
    kept.push(hint);
    used += cost;
  }

  return kept;
}

/** Short, contextual hint bar. The complete keymap lives behind `?`. */
export function KeyHints({
  width,
  playing,
  hasTrack,
}: {
  width: number;
  playing: boolean;
  hasTrack: boolean;
}) {
  return (
    <box flexDirection="row" paddingX={1} gap={GAP} flexShrink={0}>
      {fitHints(barFor({ playing, hasTrack }), width).map(({ key, action }) => (
        <text key={key}>
          <span fg={theme.text}>{key}</span>
          <span fg={theme.label}> {action}</span>
        </text>
      ))}
    </box>
  );
}
