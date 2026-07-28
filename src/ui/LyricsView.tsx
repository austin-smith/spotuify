import { useEffect } from "react";
import { isSection } from "../api/lyrics.ts";
import type { PlayableItem } from "../api/types.ts";
import { useLyrics } from "../store/lyrics.ts";
import { Overlay, OverlayTitle, overlayInnerWidth, overlayListHeight } from "./Overlay.tsx";
import { truncate, wrap } from "./text.ts";
import { theme } from "./theme.ts";

/** Left inset for the lyric itself, so it does not start hard against the overlay padding. */
const INDENT = 2;
/** Width the scrollbar column occupies on the right. */
const GUTTER = 2;

export interface DisplayLine {
  text: string;
  section: boolean;
  /** A wrapped remainder rather than the start of a line, so it can be set slightly back. */
  continuation: boolean;
}

/**
 * Lay a lyric out for a given width.
 *
 * Pure and exported so the layout is verified by tests rather than by eye: the wrap point moves with
 * the terminal, and a lyric that silently loses its last word at 92 columns is not something a
 * screenshot would catch.
 */
export function layoutLyrics(lines: string[], width: number): DisplayLine[] {
  // Every chunk uses the continuation inset as its budget. The first chunk renders two columns
  // farther left, but sharing the narrower budget guarantees both kinds leave the scrollbar gutter
  // intact instead of letting a full continuation row overwrite it.
  const usable = Math.max(1, width - (INDENT + 2) - GUTTER);

  return lines.flatMap((line) => {
    if (line.trim().length === 0) return [{ text: "", section: false, continuation: false }];
    const section = isSection(line);
    return wrap(line, usable).map((text, index) => ({
      text,
      section,
      continuation: index > 0,
    }));
  });
}

/**
 * Join what fits, dropping whole parts from the end rather than cutting one mid-word.
 *
 * The shell truncates the status line to make room for the hints on the right, so at 60 columns
 * "1–11 of 16 · radiohead · genius.com" came out as "1–11 of 16 · radiohea…". Losing the
 * attribution is better than losing the middle of a word.
 */
export function fitStatus(parts: string[], budget: number): string {
  const kept = parts.filter((part) => part.length > 0);
  while (kept.length > 1 && Bun.stringWidth(kept.join(" · ")) > budget) kept.pop();
  return kept.join(" · ");
}

/** Track, thumb and thumb extent for the scroll indicator. */
function thumbRange(total: number, viewport: number, offset: number): [number, number] {
  const size = Math.max(1, Math.round((viewport / total) * viewport));
  const span = Math.max(1, total - viewport);
  const top = Math.round((offset / span) * (viewport - size));
  return [top, top + size];
}

/**
 * The lyric for the playing track, scraped from Genius.
 *
 * Scrolls rather than pages: a lyric is one continuous thing, and losing your place at a page
 * boundary is worse than a slightly slower read down.
 */
export function LyricsView({
  width,
  height,
  item,
}: {
  width: number;
  height: number;
  item: PlayableItem | null;
}) {
  const lyrics = useLyrics((s) => s.lyrics);
  const loading = useLyrics((s) => s.loading);
  const error = useLyrics((s) => s.error);
  const offset = useLyrics((s) => s.offset);
  const setTotal = useLyrics((s) => s.setTotal);

  const inner = overlayInnerWidth(width);
  const viewport = overlayListHeight(height);
  const display = layoutLyrics(lyrics?.lines ?? [], inner);

  // Scrolling is clamped in the store, which cannot know how many rows the text became until it has
  // been laid out for this width.
  useEffect(() => {
    setTotal(display.length, viewport);
  }, [display.length, viewport, setTotal]);

  const visible = display.slice(offset, offset + viewport);
  const scrollable = display.length > viewport;
  const [thumbTop, thumbBottom] = scrollable
    ? thumbRange(display.length, viewport, offset)
    : [0, 0];

  const status = (() => {
    if (error !== null) return error;
    if (loading) return "searching genius…";
    if (lyrics === null) return "no lyrics";
    const range = scrollable
      ? `${offset + 1}–${Math.min(display.length, offset + viewport)} of ${display.length}`
      : "";
    // The same budget the shell truncates at, so parts are dropped before it has to cut one.
    return fitStatus([range, lyrics.artists.toLowerCase(), "genius.com"], inner - 30);
  })();

  return (
    <Overlay
      width={width}
      height={height}
      header={
        <OverlayTitle
          glyph="♪"
          title={truncate((item?.name ?? "lyrics").toUpperCase(), inner - 4)}
        />
      }
      status={status}
      isError={error !== null}
      hints={error !== null ? "r retry · esc close" : "↑↓ scroll · esc close"}
    >
      {visible.map((line, index) => {
        const inThumb = index >= thumbTop && index < thumbBottom;
        const content =
          line.text.length === 0
            ? ""
            : `${" ".repeat(line.continuation ? INDENT + 2 : INDENT)}${line.text}`;
        return (
          <box key={`${offset + index}`} flexDirection="row">
            <text fg={line.section ? theme.accent : theme.text}>
              {line.section ? <strong>{content}</strong> : content}
            </text>
            {scrollable ? (
              <box flexGrow={1} flexDirection="row" justifyContent="flex-end">
                <text fg={inThumb ? theme.accent : theme.faint}>{inThumb ? "┃" : "│"}</text>
              </box>
            ) : null}
          </box>
        );
      })}
    </Overlay>
  );
}
