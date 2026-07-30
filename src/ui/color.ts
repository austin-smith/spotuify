/**
 * Colour interpolation, for transitions between palette entries.
 *
 * A terminal cannot move text by half a row, so position can only ever be stepped. Colour is the one
 * axis with real resolution — 24 bits of it — which makes it the only place a transition can
 * genuinely be smooth rather than merely fast.
 *
 * Everything here interpolates *between* colours the theme already defines. It never invents one:
 * the palette is deliberately fixed, and a colour that varies per track is exactly what `theme.ts`
 * rejects.
 */

/** `#rgb` or `#rrggbb` to components, or null for anything this does not understand. */
function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");

  if (hex.length === 3) {
    const [r, g, b] = [...hex].map((digit) => Number.parseInt(digit + digit, 16));
    return r === undefined || g === undefined || b === undefined || Number.isNaN(r + g + b)
      ? null
      : [r, g, b];
  }

  if (hex.length !== 6) return null;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return Number.isNaN(r + g + b) ? null : [r, g, b];
}

function toHex(channel: number): string {
  return Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * Blend two colours, `t` running from `from` at 0 to `to` at 1.
 *
 * Interpolates in plain sRGB rather than a perceptual space. The palette's steps are close enough
 * together that the difference is invisible over a 150ms transition, and the conversion either way
 * would cost more than it buys.
 */
export function lerpColor(from: string, to: string, t: number): string {
  if (t <= 0) return from;
  if (t >= 1) return to;

  const start = parseHex(from);
  const end = parseHex(to);
  // A colour that cannot be parsed is passed through rather than silently rendered as black.
  if (start === null || end === null) return t < 0.5 ? from : to;

  const channels = start.map((channel, index) => channel + (end[index]! - channel) * t);
  return `#${channels.map(toHex).join("")}`;
}

/**
 * Ease out, so a transition arrives quickly and settles.
 *
 * A linear fade reads as a mechanical wipe; front-loading the movement is what makes it look like
 * the page came to rest rather than being dragged.
 */
export function easeOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) ** 3;
}
