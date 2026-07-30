/**
 * Fixed, high-contrast palette.
 *
 * Deliberately *not* derived from album art. Sampling produced an unpredictable, usually muddy
 * color, applied it to the largest element on screen, and left the app with no identity of its own
 * — it looked different every track without ever looking better.
 *
 * Swap `ACCENT` alone to reskin: amber `#ffb000`, phosphor `#33ff66`, magenta `#ff4fa3`.
 */
const ACCENT = "#1ed760";

export const theme = {
  accent: ACCENT,
  /** Dimmed accent for filled-but-inactive elements (e.g. the played part of a bar). */
  accentDim: "#12622f",
  /** Panel borders and separators — present but quiet. */
  chrome: "#2e2e34",
  /** Primary values: track title, times. Near-white for real hierarchy against labels. */
  text: "#f2f2f2",
  /** Secondary values: artist, album, device. */
  muted: "#a8a8b0",
  /** Field labels and the keybind strip. */
  label: "#70707a",
  /** Lowest tier — inactive states, empty bar track. */
  faint: "#3a3a42",
  /** Opaque field background, so the caret occupies a whole cell instead of half of one. */
  inputBackground: "#15151a",
  error: "#ff5c4d",
  ok: ACCENT,
  /** Text sitting on the darkened band of the cover — lifted so it survives a busy image. */
  scrimText: "#b4b4bc",
  /** Unfilled seek-bar track over the scrim. */
  scrimBar: "#54545c",
} as const;
