import { KEYMAP, type KeyGroup } from "./keys.ts";
import { theme } from "./theme.ts";

/** Width of the key column, so actions line up within a column. */
const KEY_WIDTH = 8;
/**
 * Below this width two columns would each be too narrow.
 *
 * Action labels are kept short enough that a column of roughly 20 cells holds the longest one, so
 * two columns work well below a standard 80-column terminal.
 */
const TWO_COLUMN_MIN = 46;

/** Gap between the two columns. */
const COLUMN_GAP = 6;

/**
 * Natural width of a column: the key column plus the longest action in it.
 *
 * Derived from the content rather than from the screen. Splitting the terminal in half left each
 * column reserving ~55 cells for ~20 cells of text, so the two sat absurdly far apart.
 */
export function columnWidthFor(groups: KeyGroup[]): number {
  const longest = groups.reduce(
    (max, group) => Math.max(max, ...group.bindings.map((b) => b.action.length), group.label.length),
    0,
  );
  return KEY_WIDTH + longest;
}

/** Rows a group occupies: its header plus one per binding. */
function rowsIn(group: KeyGroup): number {
  return group.bindings.length + 1;
}

/**
 * Split the groups into two balanced columns.
 *
 * Stacked in one column the list is taller than most terminals and the last group gets clipped.
 */
export function splitGroups(groups: KeyGroup[]): [KeyGroup[], KeyGroup[]] {
  const total = groups.reduce((sum, g) => sum + rowsIn(g), 0);
  const left: KeyGroup[] = [];
  let used = 0;

  for (const group of groups) {
    // Keep filling the left column while doing so stays nearer the halfway mark.
    if (left.length > 0 && used + rowsIn(group) / 2 > total / 2) break;
    left.push(group);
    used += rowsIn(group);
  }

  return [left, groups.slice(left.length)];
}

/**
 * Groups that fit entirely within `maxRows`.
 *
 * Dropping a whole group is better than clipping one: a header with nothing under it reads as a
 * rendering fault rather than a short list.
 */
export function groupsThatFit(groups: KeyGroup[], maxRows: number): KeyGroup[] {
  const kept: KeyGroup[] = [];
  let used = 0;

  for (const group of groups) {
    const cost = rowsIn(group) + (kept.length > 0 ? 1 : 0);
    // The first group is always kept: on a very short terminal a partly-visible list beats a blank
    // screen, and dropping everything would be the worse failure.
    if (kept.length > 0 && used + cost > maxRows) break;
    kept.push(group);
    used += cost;
  }

  return kept;
}

function Column({
  groups,
  width,
  maxRows,
}: {
  groups: KeyGroup[];
  width: number;
  maxRows: number;
}) {
  return (
    <box flexDirection="column" width={width} flexShrink={0}>
      {groupsThatFit(groups, maxRows).map((group, index) => (
        <box
          key={group.label}
          flexDirection="column"
          flexShrink={0}
          height={rowsIn(group)}
          marginTop={index === 0 ? 0 : 1}
        >
          <text fg={theme.label}>
            <strong>{group.label}</strong>
          </text>
          {group.bindings.map(({ key, action }) => (
            <text key={`${group.label}-${key}-${action}`}>
              <span fg={theme.text}>{key.padEnd(KEY_WIDTH)}</span>
              <span fg={theme.muted}>{action}</span>
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}

/** The complete keymap, opened with `?`. Everything the hint bar leaves out lives here. */
export function KeymapOverlay({ width, height }: { width: number; height: number }) {
  const inner = width - 8;
  const twoColumn = inner >= TWO_COLUMN_MIN;
  const [left, right] = twoColumn ? splitGroups(KEYMAP) : [KEYMAP, []];
  const leftWidth = columnWidthFor(left);
  const rightWidth = right.length > 0 ? columnWidthFor(right) : 0;
  // The rule spans only the block, not the screen, so the overlay reads as one object.
  const ruleWidth = Math.min(
    inner,
    leftWidth + (rightWidth > 0 ? COLUMN_GAP + rightWidth : 0),
  );
  // Vertical padding (4), the title, the rule and its margin (3), and the footer (1).
  const maxRows = Math.max(1, height - 8);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={10}
      // Both axes at once: the inner block is sized to its own content, and this box centres it
      // horizontally and vertically so it reads as a dialog rather than a corner fragment.
      alignItems="center"
      justifyContent="center"
    >
      <box flexDirection="column" width={ruleWidth} flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.accent}>
            <strong>?</strong>
          </text>
          <text fg={theme.text}>
            <strong>KEYS</strong>
          </text>
        </box>

        <box marginTop={1}>
          <text fg={theme.faint}>{"─".repeat(Math.max(0, ruleWidth))}</text>
        </box>

        <box flexDirection="row" overflow="hidden" marginTop={1} gap={COLUMN_GAP}>
          <Column groups={left} width={leftWidth} maxRows={maxRows} />
          {right.length > 0 ? (
            <Column groups={right} width={rightWidth} maxRows={maxRows} />
          ) : null}
        </box>

        <box flexDirection="row" marginTop={1} justifyContent="flex-end">
          <text fg={theme.faint}>esc close</text>
        </box>
      </box>
    </box>
  );
}
