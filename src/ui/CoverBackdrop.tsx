import { FrameBufferRenderable, RGBA } from "@opentui/core";
import { ptr } from "bun:ffi";
import { useEffect, useRef } from "react";
import type { Image } from "../api/types.ts";
import { chooseImage, flattenCellRow, loadCoverArt, pixelDimsFor, type ArtBitmap } from "./art.ts";

const cache = new Map<string, ArtBitmap>();

interface CoverBackdropProps {
  images: Image[];
  /** Full terminal size in cells — the backdrop covers all of it. */
  width: number;
  height: number;
  /** Cell row from which the art is darkened, so the HUD stays legible. */
  scrimFromRow: number;
  /** Darken the whole cover, for overlays that need the full screen readable. */
  dim?: boolean;
  /**
   * Cell row to draw as solid single-color cells rather than half-blocks.
   *
   * A terminal's block cursor fills an entire cell, so it only looks right over a cell holding one
   * color. This flattens the row the caret sits on; the row loses half its vertical detail, which
   * is imperceptible across a single row.
   */
  solidRow?: number | null;
}

/**
 * The album cover, filling the entire terminal behind the HUD.
 *
 * Absolutely positioned at the origin with the lowest z-index so every overlay draws on top. This
 * replaced a centered square: with the art bounded by the smaller axis there was always a leftover
 * band, and no amount of aligning made that band look intentional.
 */
export function CoverBackdrop({
  images,
  width,
  height,
  scrimFromRow,
  dim = false,
  solidRow = null,
}: CoverBackdropProps) {
  const hostRef = useRef<any>(null);
  const fbRef = useRef<FrameBufferRenderable | null>(null);

  const url =
    images.length > 0
      ? chooseImage(images, pixelDimsFor(width, height).width)?.url
      : undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || url === undefined || width < 8 || height < 6) return;

    const controller = new AbortController();
    let disposed = false;

    void (async () => {
      // Terminals have no alpha compositing, so dimming is baked into the pixel buffer. The dimmed
      // variant is a separate cache entry, costing one decode per album.
      const scrim = dim ? 0 : scrimFromRow;
      const key = `${url}@${width}x${height}@${scrim}`;
      try {
        let art = cache.get(key);
        if (art === undefined) {
          art = await loadCoverArt(url, width, height, scrim, controller.signal);
          cache.set(key, art);
        }
        if (disposed) return;

        fbRef.current?.destroyRecursively?.();
        const fb = new FrameBufferRenderable(host.ctx, {
          id: "cover-backdrop",
          width,
          height,
        });
        fb.frameBuffer.drawSuperSampleBuffer(
          0,
          0,
          ptr(art.rgba),
          art.rgba.length,
          "rgba8unorm",
          art.width * 4,
        );
        if (solidRow !== null && solidRow >= 0 && solidRow < height) {
          const flat = flattenCellRow(art.rgba, art.width, art.height, solidRow);
          const fg = RGBA.fromInts(255, 255, 255, 255);
          flat.forEach((color: { r: number; g: number; b: number }, x: number) => {
            fb.frameBuffer.setCell(
              x,
              solidRow,
              " ",
              fg,
              RGBA.fromInts(color.r, color.g, color.b, 255),
            );
          });
        }

        host.add(fb);
        fbRef.current = fb;
      } catch {
        // The backdrop is decoration; a failed fetch leaves the plain background.
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      fbRef.current?.destroyRecursively?.();
      fbRef.current = null;
    };
  }, [url, width, height, scrimFromRow, dim, solidRow]);

  return (
    <box
      ref={hostRef}
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={0}
      overflow="hidden"
    />
  );
}
