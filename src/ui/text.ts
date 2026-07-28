/**
 * Clip to `max` cells, marking the cut with an ellipsis.
 *
 * Every overlay needs this and each one had its own copy. Truncating rather than wrapping is
 * deliberate: a wrapped line pushes everything below it down by a row, which in a fixed-height
 * overlay means the footer falls off the bottom of the screen.
 */
export function truncate(value: string, max: number): string {
  if (max <= 1) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
