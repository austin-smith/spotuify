import { FrameBufferRenderable } from "@opentui/core";
import { ptr } from "bun:ffi";
import { useEffect, useRef } from "react";
import type { Image } from "../api/types.ts";
import { chooseImage, loadArt, pixelDimsFor, type ArtBitmap } from "./art.ts";
import { theme } from "./theme.ts";

/** Decoded art is cached by URL+size so track changes within an album don't refetch or re-decode. */
const cache = new Map<string, ArtBitmap>();

interface AlbumArtProps {
  images: Image[];
  /** Exact cell size, decided by `chooseLayout` — the art never negotiates its own size. */
  cells: { w: number; h: number };
}

export function AlbumArt({ images, cells }: AlbumArtProps) {
  const hostRef = useRef<any>(null);
  const fbRef = useRef<FrameBufferRenderable | null>(null);
  const url = images.length > 0 ? chooseImage(images, pixelDimsFor(cells.w, cells.h).width)?.url : undefined;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || url === undefined) return;

    const controller = new AbortController();
    let disposed = false;

    void (async () => {
      const key = `${url}@${cells.w}x${cells.h}`;
      try {
        let art = cache.get(key);
        if (art === undefined) {
          art = await loadArt(url, cells.w, cells.h, controller.signal);
          cache.set(key, art);
        }
        if (disposed) return;

        // Replace rather than resize: a stale buffer would draw the previous cover at the wrong
        // scale for a frame.
        fbRef.current?.destroyRecursively?.();

        const fb = new FrameBufferRenderable(host.ctx, {
          id: "album-art",
          width: cells.w,
          height: cells.h,
        });
        fb.frameBuffer.drawSuperSampleBuffer(
          0,
          0,
          ptr(art.rgba),
          art.rgba.length,
          "rgba8unorm",
          art.width * 4,
        );
        host.add(fb);
        fbRef.current = fb;
      } catch {
        // Art is decoration: a failed fetch or a non-JPEG cover must not disturb playback.
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      fbRef.current?.destroyRecursively?.();
      fbRef.current = null;
    };
  }, [url, cells.w, cells.h]);

  return (
    <box
      ref={hostRef}
      width={cells.w}
      height={cells.h}
      flexShrink={0}
      overflow="hidden"
      alignItems="center"
      justifyContent="center"
      backgroundColor={theme.faint}
    />
  );
}
