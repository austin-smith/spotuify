import { theme } from "./theme.ts";

/**
 * Keybind strip.
 *
 * Spelled out rather than pictographic: glyphs like `⤮` and `↻` are unreadable at terminal sizes,
 * and repeat/refresh in particular are indistinguishable as circular arrows.
 */
const HINTS: ReadonlyArray<readonly [key: string, action: string]> = [
  ["SPACE", "play/pause"],
  ["N", "next"],
  ["P", "prev"],
  ["←/→", "seek"],
  ["↑/↓", "volume"],
  ["S", "shuffle"],
  ["Z", "repeat"],
  ["R", "sync"],
  ["Q", "quit"],
];

/** Rendered width of the full strip: `key action` per hint, plus the flex gap between them. */
const GAP = 2;
function stripWidth(hints: typeof HINTS): number {
  const content = hints.reduce((sum, [key, action]) => sum + key.length + 1 + action.length, 0);
  return content + GAP * (hints.length - 1);
}

export function KeyHints({ width }: { width: number }) {
  // Under pressure, drop the labels and keep the keys — still useful, never wraps mid-hint.
  const compact = stripWidth(HINTS) > width - 2;

  return (
    <box flexDirection="row" paddingX={1} gap={2} flexShrink={0}>
      {HINTS.map(([key, action]) => (
        <text key={key}>
          <span fg={theme.text}>{key}</span>
          {compact ? null : <span fg={theme.label}> {action}</span>}
        </text>
      ))}
    </box>
  );
}
