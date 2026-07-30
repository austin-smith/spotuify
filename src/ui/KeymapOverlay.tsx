import { KEYMAP, type KeyGroup } from "./keys.ts";
import { theme } from "./theme.ts";
import type { EngineStatus } from "../engine/librespot.ts";
import { truncate } from "./text.ts";

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

export function keymapFor(canBrowse: boolean): KeyGroup[] {
  if (canBrowse) return KEYMAP;
  return KEYMAP.map((group) =>
    group.label === "BROWSE"
      ? {
          ...group,
          bindings: group.bindings
            .filter(({ key }) => key !== "/" && key !== "a" && key !== "d")
            .map((binding) =>
              binding.key === "r" ? { ...binding, action: "retry account" } : binding,
            ),
        }
      : group,
  );
}

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

/**
 * The keymap, plus who is signed in and whether the engine is up.
 *
 * Account and engine state live here rather than on the now-playing view: they are reference
 * information, and anything permanently overlaid on the cover needs darkening behind it, which
 * always ends up looking like a patch stuck on the artwork.
 */
export function KeymapOverlay({
  width,
  height,
  account,
  product,
  engine,
  webAccountId,
  canBrowse = true,
}: {
  width: number;
  height: number;
  account: string;
  product: string | undefined;
  engine: EngineStatus;
  webAccountId: string | null;
  canBrowse?: boolean;
}) {
  const inner = Math.max(0, width - 8);
  const twoColumn = inner >= TWO_COLUMN_MIN;
  const keymap = keymapFor(canBrowse);
  const [left, right] = twoColumn ? splitGroups(keymap) : [keymap, []];
  const leftWidth = columnWidthFor(left);
  const rightWidth = right.length > 0 ? columnWidthFor(right) : 0;
  // The rule spans only the block, not the screen, so the overlay reads as one object.
  const nativeAccountMatches =
    engine.state === "ready" &&
    webAccountId !== null &&
    engine.accountId === webAccountId;
  const rawEngineLabel =
    engine.state === "ready"
      ? webAccountId === null
        ? "local playback waiting for account verification"
        : engine.accountId !== webAccountId
          ? "local playback account mismatch — run: spotuify auth --force-engine"
          : "local playback ready"
      : engine.state === "starting"
        ? "local playback starting"
        : engine.state === "missing"
          ? "local playback engine missing — run: bun run engine:build"
          : engine.state === "disabled"
            ? "local playback disabled"
            : `local playback failed — ${engine.reason}`;
  const engineLabel = truncate(rawEngineLabel, Math.max(0, inner - 2));
  const engineUp = nativeAccountMatches;
  const ruleWidth = Math.min(
    inner,
    Math.max(
      engineLabel.length + 2,
      leftWidth + (rightWidth > 0 ? COLUMN_GAP + rightWidth : 0),
    ),
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
            <strong>SPOTUIFY</strong>
          </text>
          <text fg={theme.label}>
            {account}
            {product !== undefined ? `  ·  ${product}` : ""}
          </text>
        </box>

        <box flexDirection="row" gap={1}>
          <text fg={engineUp ? theme.accent : theme.error}>{engineUp ? "●" : "✗"}</text>
          <text fg={theme.label}>{engineLabel}</text>
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
