const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sliceColumns(value: string, max: number): string {
  let result = "";
  let width = 0;
  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = Bun.stringWidth(segment);
    if (width + segmentWidth > max) break;
    result += segment;
    width += segmentWidth;
  }
  return result;
}

/**
 * Clip to `max` cells, marking the cut with an ellipsis.
 *
 * Every overlay needs this and each one had its own copy. Truncating rather than wrapping is
 * deliberate: a wrapped line pushes everything below it down by a row, which in a fixed-height
 * overlay means the footer falls off the bottom of the screen.
 */
export function truncate(value: string, max: number): string {
  if (max <= 1) return "";
  return Bun.stringWidth(value) <= max ? value : `${sliceColumns(value, max - 1)}…`;
}

/** Truncate and pad text to an exact terminal-cell width. */
export function padColumns(value: string, width: number): string {
  const clipped = truncate(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - Bun.stringWidth(clipped)))}`;
}

/** Split a word into chunks that each fit a terminal-column budget. */
function splitWord(value: string, max: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let width = 0;

  for (const { segment } of graphemes.segment(value)) {
    const segmentWidth = Bun.stringWidth(segment);
    if (segmentWidth > max) {
      if (chunk.length > 0) {
        chunks.push(chunk);
        chunk = "";
        width = 0;
      }
      // A wide grapheme physically cannot fit in a one-cell viewport. Preserve the fact that
      // something is present without corrupting the neighboring cell.
      chunks.push("…");
      continue;
    }
    if (chunk.length > 0 && width + segmentWidth > max) {
      chunks.push(chunk);
      chunk = "";
      width = 0;
    }
    chunk += segment;
    width += segmentWidth;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/**
 * Break a line onto as many rows as it needs, on word boundaries.
 *
 * The counterpart to `truncate` for content whose caller has allocated the resulting rows. A lyric
 * line or actionable guidance cut at the right edge loses information the reader needs.
 */
export function wrap(value: string, max: number): string[] {
  if (max <= 0) return [];
  if (Bun.stringWidth(value) <= max) return [value];

  const rows: string[] = [];
  let row = "";

  for (const word of value.split(" ")) {
    if (row.length === 0) {
      row = word;
    } else if (Bun.stringWidth(`${row} ${word}`) <= max) {
      row = `${row} ${word}`;
    } else {
      rows.push(row);
      row = word;
    }

    // A single word longer than the line — a URL, or someone leaning on a vowel — has no break to
    // use, so it is cut at the edge rather than allowed to overflow the row.
    if (Bun.stringWidth(row) > max) {
      const chunks = splitWord(row, max);
      rows.push(...chunks.slice(0, -1));
      row = chunks.at(-1) ?? "";
    }
  }

  if (row.length > 0) rows.push(row);
  return rows;
}
