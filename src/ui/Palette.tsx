import type { MouseEvent } from "@opentui/core";
import { useSearch } from "../store/search.ts";
import { windowStart, type Row } from "../store/rows.ts";
import { SEARCH_SCOPE_LABEL } from "../api/search.ts";
import {
  Overlay,
  OVERLAY_TOP,
  overlayInnerWidth,
  overlayListHeight,
  scrollSteps,
} from "./Overlay.tsx";
import { padColumns, truncate } from "./text.ts";
import { theme } from "./theme.ts";

/**
 * Screen row the query line sits on.
 *
 * The cover backdrop flattens this row to solid cells: the art is drawn as two-tone half-blocks and
 * the terminal's own block caret composites badly against them.
 */
export const PROMPT_ROW = OVERLAY_TOP;

interface Columns {
  label: number;
  detail: number;
  trailing: number;
}

/**
 * Column widths for the whole list.
 *
 * Computed once and applied to every row, including rows with no detail or trailing value. Sizing
 * per row instead made the detail and duration columns start at different offsets depending on
 * which fields that row happened to have.
 */
const LABEL_MAX = 40;
const DETAIL_MAX = 28;

function widest(rows: Row[], field: "label" | "detail"): number {
  return rows.reduce((width, row) => {
    if (row.kind !== "result") return width;
    return Math.max(width, Bun.stringWidth(row[field]));
  }, 0);
}

function columnsFor(width: number, rows: Row[]): Columns {
  const trailing = 6;
  const gutter = 2;
  const available = Math.max(10, width - gutter - trailing - 2);
  const desiredLabel = Math.min(LABEL_MAX, Math.max(8, widest(rows, "label")));
  const desiredDetail = Math.min(DETAIL_MAX, widest(rows, "detail"));
  // Size to the content at roomy widths. Only fall back to a proportional split when the terminal
  // cannot fit both desired columns; this keeps related values together instead of stretching them
  // across every spare cell.
  const label = Math.min(desiredLabel, Math.max(8, Math.floor(available * 0.58)));
  const detail = Math.min(desiredDetail, Math.max(0, available - label));
  return { label, detail, trailing };
}

function HeaderRow({
  row,
}: {
  row: Extract<Row, { kind: "header" }>;
}) {
  return (
    <text fg={theme.label}>
      <strong>{row.label}</strong>
    </text>
  );
}

function ResultRow({
  row,
  selected,
  columns,
}: {
  row: Extract<Row, { kind: "result" }>;
  selected: boolean;
  columns: Columns;
}) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={selected ? theme.accent : theme.faint}>{selected ? "▌" : " "}</text>
      <text fg={selected ? theme.text : theme.muted}>
        {padColumns(row.label, columns.label)}
      </text>
      <text fg={selected ? theme.muted : theme.label}>
        {padColumns(row.detail, columns.detail)}
      </text>
      <text fg={theme.label}>{row.trailing.padStart(columns.trailing)}</text>
    </box>
  );
}

function MoreRow({
  row,
  selected,
  columns,
}: {
  row: Extract<Row, { kind: "more" }>;
  selected: boolean;
  columns: Columns;
}) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={selected ? theme.accent : theme.faint}>{selected ? "▌" : " "}</text>
      <text
        fg={
          row.error
            ? theme.error
            : row.loading
              ? theme.label
              : selected
                ? theme.accent
                : theme.label
        }
      >
        {truncate(row.label, columns.label)}
      </text>
      {row.detail === "" ? null : (
        <text fg={theme.label}>
          {truncate(row.detail, columns.detail + columns.trailing + 1)}
        </text>
      )}
    </box>
  );
}

/**
 * Search palette, overlaid on a dimmed cover.
 *
 * The query stays focused throughout: typing edits it, arrows move the selected result, and Tab
 * changes the scope directly. Printable keys therefore never change meaning behind the user.
 */
export function Palette({ width, height }: { width: number; height: number }) {
  // Frames live in the store; these selectors read whichever one is on top.
  const frames = useSearch((s) => s.frames);
  const query = useSearch((s) => s.query);
  const error = useSearch((s) => s.error);
  const scope = useSearch((s) => s.scope);
  const setQuery = useSearch((s) => s.setQuery);
  const move = useSearch((s) => s.move);
  const showingHome = useSearch((s) => s.showingHome);
  const showingReference = useSearch((s) => s.showingReference);

  void query; // subscribed above so root typing re-renders; value read via store.text()
  const store = useSearch.getState();
  const rows = store.rows();
  const selected = store.selected();
  const loading = store.loading();
  const breadcrumb = store.breadcrumb();
  const text = store.text();
  const drilled = frames.length > 1;
  const scopeLabel = showingReference ? "DIRECT" : SEARCH_SCOPE_LABEL[scope];

  const inner = overlayInnerWidth(width);
  const columns = columnsFor(inner, rows);
  const listHeight = overlayListHeight(height);
  const start = windowStart(rows, selected, listHeight);
  const visible = rows.slice(start, start + listHeight);

  const resultCount = rows.filter((r) => r.kind === "result").length;
  const status = (() => {
    if (error !== null) return error;
    if (loading) {
      if (drilled) return "loading…";
      if (showingHome) return "loading your library…";
      return showingReference ? "resolving Spotify reference…" : "searching…";
    }
    if (drilled) {
      return resultCount === 0 ? "nothing here" : `${resultCount} — type to filter`;
    }
    if (showingHome) {
      const destination =
        scope === "all" ? "tracks, artists, albums and playlists" : scopeLabel.toLowerCase();
      return resultCount === 0
        ? `type to search ${destination}`
        : scope === "all"
          ? "your library — or type to search"
          : `your library — search scope: ${destination}`;
    }
    if (showingReference) {
      return resultCount === 0
        ? "paste a complete Spotify link or URI"
        : "Spotify reference — press enter to open";
    }
    if (resultCount === 0) return "no results";
    return "";
  })();

  // The palette has no free scroll position — the viewport is derived from the selection — so the
  // wheel walks the selection exactly as the arrow keys do and the window follows it.
  const handleMouseScroll = (event: MouseEvent) => {
    const rows = scrollSteps(event);
    if (rows === null) return;
    move(rows);
    event.stopPropagation();
  };

  const hints = (() => {
    if (drilled) return "type to filter · ↑↓ move · ↵ play · esc back";
    if (showingReference) return "↑↓ move · ↵ open · esc close";
    return inner < 72
      ? "tab scope · ↑↓ move · ↵ open"
      : "tab scope · ↑↓ move · ↵ open · esc close";
  })();

  return (
    <Overlay
      width={width}
      height={height}
      status={status}
      isError={error !== null}
      hints={hints}
      onMouseScroll={handleMouseScroll}
      header={
        <box flexDirection="row" gap={1}>
          <text fg={theme.accent}>
            <strong>{drilled ? "‹" : "›"}</strong>
          </text>
          {breadcrumb !== null ? (
            <text fg={theme.muted}>
              {truncate(breadcrumb, Math.max(0, inner - 24))}
              <span fg={theme.faint}>{text.length > 0 ? `   /${text}` : ""}</span>
            </text>
          ) : (
            <text fg={theme.muted}>
              {"["}
              <strong>{scopeLabel}</strong>
              {"]"}
            </text>
          )}
          <input
            value={text}
            // `onInput` fires per keystroke; `onChange` only commits later, which left the store
            // holding an empty query while the field showed typed text.
            onInput={setQuery}
            // Empty when drilled: the field is collapsed to zero width there and would otherwise
            // render the first character of its placeholder next to the breadcrumb.
            placeholder={drilled ? "" : "search"}
            focused
            width={breadcrumb !== null ? 0 : undefined}
            flexBasis={0}
            flexGrow={breadcrumb === null ? 1 : 0}
            minWidth={breadcrumb === null ? 1 : 0}
            textColor={theme.text}
            cursorColor={theme.accent}
            placeholderColor={theme.label}
          />
        </box>
      }
    >
      {visible.map((row, offset) =>
        row.kind === "header" ? (
          <HeaderRow
            key={`h${start + offset}`}
            row={row}
          />
        ) : row.kind === "result" ? (
          <ResultRow
            key={`r${start + offset}`}
            row={row}
            selected={start + offset === selected}
            columns={columns}
          />
        ) : (
          <MoreRow
            key={`m${start + offset}`}
            row={row}
            selected={start + offset === selected}
            columns={columns}
          />
        ),
      )}
    </Overlay>
  );
}
