import { useSearch } from "../store/search.ts";
import { windowStart, type Row } from "../store/rows.ts";
import { theme } from "./theme.ts";

/** Screen row the query line sits on, given the palette's vertical padding. */
export const PROMPT_ROW = 2;

/** Rows reserved for the prompt, its rule, and the footer hint. */
const CHROME_ROWS = 6;

function truncate(value: string, max: number): string {
  if (max <= 1) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

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
const LABEL_MAX = 46;
const DETAIL_MAX = 28;

function columnsFor(width: number): Columns {
  const trailing = 6;
  const gutter = 2;
  const available = Math.max(10, width - gutter - trailing - 2);
  // Capped rather than proportional: at 55% of a wide terminal the artist ended up far across the
  // screen from the title, so each row read as two disconnected lists.
  const label = Math.min(LABEL_MAX, Math.max(8, Math.floor(available * 0.55)));
  const detail = Math.min(DETAIL_MAX, Math.max(0, available - label));
  return { label, detail, trailing };
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
        {truncate(row.label, columns.label).padEnd(columns.label)}
      </text>
      <text fg={selected ? theme.muted : theme.label}>
        {truncate(row.detail, columns.detail).padEnd(columns.detail)}
      </text>
      <text fg={theme.label}>{row.trailing.padStart(columns.trailing)}</text>
    </box>
  );
}

/**
 * Search palette, overlaid on a dimmed cover.
 *
 * The input keeps focus for the whole session and navigation is handled by the app's global key
 * handler, so typing and moving through results never require a focus switch.
 */
export function Palette({ width, height }: { width: number; height: number }) {
  // Frames live in the store; these selectors read whichever one is on top.
  const frames = useSearch((s) => s.frames);
  const query = useSearch((s) => s.query);
  const error = useSearch((s) => s.error);
  const setQuery = useSearch((s) => s.setQuery);
  const showingHome = useSearch((s) => s.showingHome);

  void query; // subscribed above so root typing re-renders; value read via store.text()
  const store = useSearch.getState();
  const rows = store.rows();
  const selected = store.selected();
  const loading = store.loading();
  const breadcrumb = store.breadcrumb();
  const text = store.text();
  const drilled = frames.length > 1;

  const inner = width - 8;
  const columns = columnsFor(inner);
  const listHeight = Math.max(3, height - CHROME_ROWS - 2);
  const start = windowStart(rows, selected, listHeight);
  const visible = rows.slice(start, start + listHeight);

  const resultCount = rows.filter((r) => r.kind === "result").length;
  const status = (() => {
    if (error !== null) return error;
    if (loading) return drilled ? "loading…" : showingHome ? "loading your library…" : "searching…";
    if (drilled) {
      return resultCount === 0 ? "nothing here" : `${resultCount} — type to filter`;
    }
    if (showingHome) {
      return resultCount === 0
        ? "type to search tracks, artists, albums and playlists"
        : "your library — or type to search";
    }
    if (resultCount === 0) return "no results";
    return `${resultCount} ${resultCount === 1 ? "result" : "results"}`;
  })();

  const hints = drilled
    ? "↑↓ move · ↵ play · esc back"
    : "↑↓ move · ↵ open · esc close";

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
          <strong>{drilled ? "‹" : "›"}</strong>
        </text>
        {breadcrumb !== null ? (
          <text fg={theme.muted}>
            {truncate(breadcrumb, Math.max(0, inner - 24))}
            <span fg={theme.faint}>{text.length > 0 ? `   /${text}` : ""}</span>
          </text>
        ) : null}
        <input
          value={text}
          // `onInput` fires per keystroke; `onChange` only commits later, which left the store
          // holding an empty query while the field showed typed text.
          onInput={setQuery}
          // Empty when drilled: the field is collapsed to zero width there and would otherwise
          // render the first character of its placeholder next to the breadcrumb.
          placeholder={drilled ? "" : "search"}
          // The field keeps focus for the whole session; the row highlight is a list cursor, not a
          // second focus. This is the combobox convention.
          focused
          width={breadcrumb !== null ? 0 : inner - 2}
          textColor={theme.text}
          cursorColor={theme.accent}
          placeholderColor={theme.label}
        />
      </box>

      <box marginTop={1}>
        <text fg={theme.faint}>{"─".repeat(Math.max(0, inner))}</text>
      </box>

      <box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
        {visible.map((row, offset) =>
          row.kind === "header" ? (
            <box key={`h${start + offset}`} marginTop={offset === 0 ? 0 : 1}>
              <text fg={theme.label}>
                <strong>{row.label}</strong>
              </text>
            </box>
          ) : (
            <ResultRow
              key={`r${start + offset}`}
              row={row}
              selected={start + offset === selected}
              columns={columns}
            />
          ),
        )}
      </box>

      <box flexDirection="row" justifyContent="space-between">
        <text fg={error !== null ? theme.error : theme.label}>{truncate(status, inner - 30)}</text>
        <text fg={theme.faint}>{hints}</text>
      </box>
    </box>
  );
}
