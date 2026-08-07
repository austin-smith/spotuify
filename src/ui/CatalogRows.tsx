import { windowStart, type Row } from "../store/rows.ts";
import { padColumns, truncate } from "./text.ts";
import { theme } from "./theme.ts";

interface Columns {
  label: number;
  detail: number;
  trailing: number;
}

const LABEL_MAX = 40;
const DETAIL_MAX = 28;

function widest(rows: Row[], field: "label" | "detail"): number {
  return rows.reduce((width, row) => {
    if (row.kind !== "result") return width;
    return Math.max(width, Bun.stringWidth(row[field]));
  }, 0);
}

/** Stable column widths for every row in one catalog or library list. */
function columnsFor(width: number, rows: Row[]): Columns {
  const trailing = 6;
  const gutter = 2;
  const available = Math.max(10, width - gutter - trailing - 2);
  const desiredLabel = Math.min(LABEL_MAX, Math.max(8, widest(rows, "label")));
  const desiredDetail = Math.min(DETAIL_MAX, widest(rows, "detail"));
  const label = Math.min(desiredLabel, Math.max(8, Math.floor(available * 0.58)));
  const detail = Math.min(desiredDetail, Math.max(0, available - label));
  return { label, detail, trailing };
}

function HeaderRow({ row }: { row: Extract<Row, { kind: "header" }> }) {
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

/** A windowed, selectable rendering of the shared Row model. */
export function CatalogRows({
  rows,
  selected,
  width,
  height,
}: {
  rows: Row[];
  selected: number;
  width: number;
  height: number;
}) {
  const columns = columnsFor(width, rows);
  const start = windowStart(rows, selected, height);
  const visible = rows.slice(start, start + height);

  return visible.map((row, offset) =>
    row.kind === "header" ? (
      <HeaderRow key={`h${start + offset}`} row={row} />
    ) : row.kind === "result" ? (
      <ResultRow
        key={`r${row.referenceUri}:${start + offset}`}
        row={row}
        selected={start + offset === selected}
        columns={columns}
      />
    ) : (
      <MoreRow
        key={`m${row.category}:${start + offset}`}
        row={row}
        selected={start + offset === selected}
        columns={columns}
      />
    ),
  );
}
