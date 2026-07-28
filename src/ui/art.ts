import jpeg from "jpeg-js";
import type { Image } from "../api/types.ts";

export interface ArtBitmap {
  /** RGBA pixels, `width * height * 4` bytes, ready for `drawSuperSampleBuffer`. */
  rgba: Uint8Array;
  /**
   * Pixel dimensions — exactly twice the cell dimensions on both axes.
   *
   * `drawSuperSampleBuffer` samples a 2x2 pixel block per cell (verified: consecutive cells read
   * source pixels 0, 2, 4… across, with the lower row driving the background of a `▀`). Supplying
   * fewer pixels per row makes it read into the following row and tile the image horizontally.
   */
  width: number;
  height: number;
}

/**
 * Display aspect ratio of a `cellsW x cellsH` region.
 *
 * A cell is roughly twice as tall as it is wide, so the region's true visual aspect is
 * `cellsW / (2 * cellsH)` — not `cellsW / cellsH`. Cropping to the wrong one squashes the cover.
 */
export function regionAspect(cellsW: number, cellsH: number): number {
  return cellsW / (2 * Math.max(1, cellsH));
}

/**
 * Largest centred rect of `srcW x srcH` matching `targetAspect`.
 *
 * Cover-crop rather than fit: a full-bleed background must fill the frame, and letterboxing a
 * square cover into a landscape terminal would reintroduce the empty bands.
 */
export function coverCrop(
  srcW: number,
  srcH: number,
  targetAspect: number,
): { x: number; y: number; w: number; h: number } {
  const srcAspect = srcW / srcH;
  if (srcAspect > targetAspect) {
    // Source too wide: trim the sides.
    const w = Math.max(1, Math.round(srcH * targetAspect));
    return { x: Math.floor((srcW - w) / 2), y: 0, w, h: srcH };
  }
  // Source too tall: trim top and bottom.
  const h = Math.max(1, Math.round(srcW / targetAspect));
  return { x: 0, y: Math.floor((srcH - h) / 2), w: srcW, h };
}

/**
 * Darken pixel rows from `fromRow` down, so overlaid text stays legible on busy art.
 *
 * Ramped over a few rows rather than a hard edge — an abrupt band looks like a rendering fault.
 */
export function applyScrim(
  rgba: Uint8Array,
  width: number,
  height: number,
  fromRow: number,
  strength = 0.82,
  rampRows = 6,
): void {
  for (let y = Math.max(0, fromRow - rampRows); y < height; y++) {
    const ramp = y < fromRow ? (y - (fromRow - rampRows)) / rampRows : 1;
    const keep = 1 - strength * Math.min(1, Math.max(0, ramp));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round((rgba[i] ?? 0) * keep);
      rgba[i + 1] = Math.round((rgba[i + 1] ?? 0) * keep);
      rgba[i + 2] = Math.round((rgba[i + 2] ?? 0) * keep);
    }
  }
}

/** Pixel buffer dimensions required to fill a `cellsW x cellsH` region. */
export function pixelDimsFor(cellsW: number, cellsH: number): { width: number; height: number } {
  return { width: cellsW * 2, height: cellsH * 2 };
}

/**
 * Cell dimensions that render `cover` art as a visually square block.
 *
 * A supersampled cell shows 1 pixel across and 2 down, and terminal cells are roughly twice as
 * tall as they are wide — so one pixel ends up about square, and a square image needs twice as
 * many columns as rows.
 */
export function fitSquare(maxCellsWide: number, maxCellsTall: number): { w: number; h: number } {
  const h = Math.max(1, Math.min(maxCellsTall, Math.floor(maxCellsWide / 2)));
  return { w: h * 2, h };
}

/**
 * Oversampling factor when choosing a source image.
 *
 * Downscaling from a source only as large as the target makes the box filter degenerate into
 * point-sampling, so ask for at least twice the target edge: a 60px target picks Spotify's 300px
 * cover rather than its 64px thumbnail.
 */
const OVERSAMPLE = 2;

/** Pick the smallest Spotify image comfortably larger than `targetEdge`, else the largest. */
export function chooseImage(images: Image[], targetEdge: number): Image | null {
  if (images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const wanted = targetEdge * OVERSAMPLE;
  return sorted.find((i) => (i.width ?? 0) >= wanted) ?? sorted.at(-1) ?? null;
}

/**
 * Box-filter downscale of an RGBA image.
 *
 * Averaging over each source rect rather than point-sampling matters here: album art is full of
 * fine detail and text, and nearest-neighbour turns it into aliased noise at 40x20.
 */
export function resizeRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
  crop?: { x: number; y: number; w: number; h: number },
): Uint8Array {
  const region = crop ?? { x: 0, y: 0, w: srcWidth, h: srcHeight };
  const dst = new Uint8Array(dstWidth * dstHeight * 4);
  const xRatio = region.w / dstWidth;
  const yRatio = region.h / dstHeight;

  for (let dy = 0; dy < dstHeight; dy++) {
    const y0 = region.y + Math.floor(dy * yRatio);
    const y1 = Math.max(y0 + 1, region.y + Math.floor((dy + 1) * yRatio));

    for (let dx = 0; dx < dstWidth; dx++) {
      const x0 = region.x + Math.floor(dx * xRatio);
      const x1 = Math.max(x0 + 1, region.x + Math.floor((dx + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < Math.min(y1, srcHeight); sy++) {
        for (let sx = x0; sx < Math.min(x1, srcWidth); sx++) {
          const i = (sy * srcWidth + sx) * 4;
          r += src[i] ?? 0;
          g += src[i + 1] ?? 0;
          b += src[i + 2] ?? 0;
          n++;
        }
      }

      const o = (dy * dstWidth + dx) * 4;
      dst[o] = n > 0 ? Math.round(r / n) : 0;
      dst[o + 1] = n > 0 ? Math.round(g / n) : 0;
      dst[o + 2] = n > 0 ? Math.round(b / n) : 0;
      dst[o + 3] = 255;
    }
  }

  return dst;
}

/**
 * Fetch and decode album art to fill a `cellsW x cellsH` region edge to edge.
 *
 * `scrimFromCell` darkens everything from that cell row down, for the HUD to sit on.
 */
export async function loadCoverArt(
  url: string,
  cellsW: number,
  cellsH: number,
  scrimFromCell: number | null,
  signal?: AbortSignal,
): Promise<ArtBitmap> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Album art fetch failed (${res.status})`);

  const decoded = jpeg.decode(new Uint8Array(await res.arrayBuffer()), { useTArray: true });
  const { width, height } = pixelDimsFor(cellsW, cellsH);
  const crop = coverCrop(decoded.width, decoded.height, regionAspect(cellsW, cellsH));

  const rgba = resizeRgba(
    new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    decoded.width,
    decoded.height,
    width,
    height,
    crop,
  );

  if (scrimFromCell !== null) applyScrim(rgba, width, height, scrimFromCell * 2);
  return { rgba, width, height };
}

/** Fetch and decode album art, scaled for a `cellsW x cellsH` region. */
export async function loadArt(
  url: string,
  cellsW: number,
  cellsH: number,
  signal?: AbortSignal,
): Promise<ArtBitmap> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error(`Album art fetch failed (${res.status})`);

  const decoded = jpeg.decode(new Uint8Array(await res.arrayBuffer()), { useTArray: true });

  // Resizing a square cover to this non-square pixel grid is deliberate: a supersampled pixel is
  // half a cell wide but a full cell tall, so a 2:1 pixel grid is what displays as a square.
  const { width, height } = pixelDimsFor(cellsW, cellsH);
  const rgba = resizeRgba(
    new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    decoded.width,
    decoded.height,
    width,
    height,
  );

  return { rgba, width, height };
}
