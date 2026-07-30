import type { MouseEvent } from "@opentui/core";
import { useEffect, useState } from "react";
import { isSection, lineAt, type LyricLine } from "../api/lyrics.ts";
import type { PlayableItem } from "../api/types.ts";
import { useLyrics } from "../store/lyrics.ts";
import { formatDuration } from "../store/progress.ts";
import { positionMs } from "../store/playback.ts";
import { Overlay, OverlayTitle, overlayInnerWidth, overlayListHeight } from "./Overlay.tsx";
import { easeOut, lerpColor } from "./color.ts";
import { truncate, wrap } from "./text.ts";
import { theme } from "./theme.ts";

/** Left inset for the lyric itself, so it does not start hard against the overlay padding. */
const INDENT = 2;
/** Width the scrollbar column occupies on the right. */
const GUTTER = 2;

/**
 * How often the sung position is re-read while following.
 *
 * A single rate. An earlier version dropped to a third of this when nothing was moving, to save
 * frames — measurement then put a render of this overlay at 0.08ms, so there were no frames worth
 * saving and the second rate only bought a self-rescheduling timer and a rationale for it.
 */
const TICK_MS = 33;

/**
 * How long the page takes to settle onto a new line.
 *
 * Chosen by eye, not derived. The snap is doing real work — it is what pulls the eye to the line now
 * being sung — so this is short enough to keep that cue rather than trade it for mush.
 */
const FADE_MS = 150;

/**
 * Delay between rows while the page walks to a new position.
 *
 * Chosen by eye, not derived: fast enough that a half-screen move finishes well inside a sung line,
 * slow enough that the rows read as movement rather than a jump.
 */
const SCROLL_STEP_MS = 28;


/**
 * Brightness by distance from the line being sung.
 *
 * The current line is the only one at full accent; everything else falls away by how far it is from
 * now, which is what makes the eye land in the right place without a cursor or a marker.
 */
const FALLOFF = [theme.accent, theme.text, theme.muted, theme.label, theme.faint] as const;

/**
 * How far a line sits from the one being sung, for the brightness falloff.
 *
 * Two cases that are not simply "distance from `current`". An unsynced lyric has no position at all,
 * so every line is held at the same weight — a gradient there would imply a place in the song that
 * nothing knows. And during the intro, before the first stamped line, the falloff is anchored just
 * above the first line rather than treated as distance zero: otherwise every line renders at full
 * brightness and the whole page drops a step the instant the singing starts.
 */
export function distanceFrom(line: number, current: number, synced: boolean): number {
  if (!synced) return 1;
  return line - (current < 0 ? -1 : current);
}

export function colorFor(distance: number): string {
  // Asymmetric on purpose: a line already sung fades a step faster than one still coming. What is
  // about to be sung is worth more of the eye than what has just gone.
  const steps = distance < 0 ? Math.abs(distance) + 1 : distance;
  return FALLOFF[Math.min(steps, FALLOFF.length - 1)] ?? theme.faint;
}

export interface DisplayLine {
  text: string;
  section: boolean;
  /** A wrapped remainder rather than the start of a line, so it can be set slightly back. */
  continuation: boolean;
  /** Index of the lyric line this row came from, for matching against the sung position. */
  line: number;
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

  return lines.flatMap((line, index) => {
    if (line.trim().length === 0) {
      return [{ text: "", section: false, continuation: false, line: index }];
    }

    const section = isSection(line);
    return wrap(line, usable).map((text, chunk) => ({
      text,
      section,
      continuation: chunk > 0,
      line: index,
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
 * Fraction of the viewport kept clear at each end before the page moves.
 *
 * The band is the whole point. Re-centring on every line meant a jump every three to five seconds,
 * and a terminal cannot move by less than a row, so that jump could never be smoothed — one row is
 * the smallest move there is. Letting the sung line drift through a band instead means the text is
 * still while you read it, then moves once and further, which is a movement large enough to animate.
 */
const SCROLL_MARGIN = 0.25;

/**
 * Where to scroll so the sung line stays readable.
 *
 * Holds the current offset while the line sits in the comfortable middle band, and re-centres only
 * when it reaches the edge. Centred on the re-centre rather than pinned to an edge: what is coming
 * next matters as much as what is being sung.
 */
export function followOffset(
  row: number,
  viewport: number,
  total: number,
  offset: number,
  lastRow = row,
): number {
  const max = Math.max(0, total - viewport);
  const clamp = (value: number) => Math.min(max, Math.max(0, value));
  const margin = Math.max(1, Math.floor(viewport * SCROLL_MARGIN));

  const settled = clamp(offset);
  // Already comfortably in view, and not against an end that would strand any continuation of the
  // current line outside the band.
  if (
    row >= settled + margin &&
    lastRow < settled + viewport - margin
  ) {
    return settled;
  }

  const span = Math.max(1, lastRow - row + 1);
  // Centre the whole wrapped line when it fits. If it is taller than the viewport, start at its
  // first row: hiding the beginning would also hide the only current-line marker.
  return clamp(
    span >= viewport
      ? row
      : Math.floor((row + lastRow) / 2) - Math.floor(viewport / 2),
  );
}

/**
 * How far through the settle onto the current line, 0 to 1.
 *
 * Derived from the playback position rather than tracked in state: the transition is a function of
 * where the song is, so it needs no bookkeeping, survives a re-render, and is exactly reproducible
 * in a test. It also means seeking never leaves a fade half-applied — land more than 150ms into a
 * line and there is simply nothing to fade.
 */
export function fadeProgress(lines: LyricLine[], current: number, positionMs: number): number {
  const start = lines[current]?.atMs;
  if (start === undefined || start === null) return 1;
  return Math.min(1, Math.max(0, (positionMs - start) / FADE_MS));
}

/** First display row belonging to a lyric line, or -1 when it is not laid out. */
function rowOf(display: DisplayLine[], line: number): number {
  return display.findIndex((row) => row.line === line);
}

/** Last display row belonging to a lyric line, or -1 when it is not laid out. */
function lastRowOf(display: DisplayLine[], line: number): number {
  return display.findLastIndex((row) => row.line === line);
}

/**
 * The lyric for the playing track, following along when the source stamped its lines.
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
  const following = useLyrics((s) => s.following);
  const lyricsTrackKey = useLyrics((s) => s.trackKey);
  const setTotal = useLyrics((s) => s.setTotal);
  const scrollBy = useLyrics((s) => s.scrollBy);
  const scrollTo = useLyrics((s) => s.scrollTo);

  const itemTrackKey = item === null ? null : (item.id ?? item.uri);
  // A parent render can carry the new playback item one effect before the lyrics store follows it.
  // Do not drive the old lyric with the new track's clock during that handoff.
  const synced = lyrics?.synced === true && lyricsTrackKey === itemTrackKey;
  // Seeded from the clock rather than zero. Starting at zero meant the first render pointed at the
  // opening line, scrolled the page there, and then corrected itself once the first tick landed —
  // a visible lurch every time the overlay was opened mid-song.
  const [clock, setClock] = useState(() => ({ trackKey: itemTrackKey, atMs: positionMs() }));
  // Effects run after paint. Read synchronously on a track change so the follow effect cannot scroll
  // the new lyric using the previous track's final position before the timer effect samples again.
  const now = clock.trackKey === itemTrackKey ? clock.atMs : positionMs();

  const inner = overlayInnerWidth(width);
  const viewport = overlayListHeight(height);
  const lines: LyricLine[] = lyrics?.lines ?? [];
  const display = layoutLyrics(
    lines.map((line) => line.text),
    inner,
  );

  // Only runs for a timed lyric. An unsynced one has nothing to animate, and ticking would redraw
  // the overlay to produce an identical frame.
  useEffect(() => {
    if (!synced) return;
    const sample = () => setClock({ trackKey: itemTrackKey, atMs: positionMs() });
    sample();
    const tick = setInterval(sample, TICK_MS);
    return () => clearInterval(tick);
  }, [synced, itemTrackKey]);

  const current = synced ? lineAt(lines, now) : -1;
  const currentRow = current < 0 ? -1 : rowOf(display, current);
  const currentLastRow = current < 0 ? -1 : lastRowOf(display, current);

  // Scrolling is clamped in the store, which cannot know how many rows the text became until it has
  // been laid out for this width.
  useEffect(() => {
    setTotal(display.length, viewport);
  }, [display.length, viewport, setTotal]);

  /**
   * Walk the scroll to where the music is, a row at a time.
   *
   * Written from an effect rather than during render: the store is the single source of scroll
   * position, so handing over to manual scrolling starts from wherever the music had reached.
   *
   * Stepped rather than jumped, because a row is the smallest move a terminal has and several of
   * them in sequence is the only "smooth" available. The target is fixed when the walk starts, so
   * the band it was computed against cannot shift underneath it mid-walk.
  */
  useEffect(() => {
    if (!synced || !following) return;

    const from = useLyrics.getState().offset;
    // Before the first stamp, following means the beginning of the lyric. This matters after a seek
    // back into the intro, when the view may still be sitting on a much later verse.
    const target =
      currentRow < 0
        ? 0
        : followOffset(currentRow, viewport, display.length, from, currentLastRow);
    if (target === from) return;

    // Anything further than a screenful is a seek or a hand-back, not the song moving on. Walking
    // that would take seconds and look broken; it belongs on screen immediately.
    if (Math.abs(target - from) > viewport) {
      scrollTo(target);
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const walk = () => {
      const at = useLyrics.getState().offset;
      if (at === target) return;
      scrollTo(at + Math.sign(target - at));
      timer = setTimeout(walk, SCROLL_STEP_MS);
    };

    timer = setTimeout(walk, SCROLL_STEP_MS);
    return () => clearTimeout(timer);
  }, [synced, following, currentRow, currentLastRow, viewport, display.length, scrollTo]);

  const visible = display.slice(offset, offset + viewport);
  const scrollable = display.length > viewport;

  const handleMouseScroll = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    if (!scrollable || (direction !== "up" && direction !== "down")) return;

    const rows = Math.max(1, Math.trunc(event.scroll?.delta ?? 1));
    scrollBy(direction === "up" ? -rows : rows, viewport);
    event.stopPropagation();
  };

  // Hidden while the music drives the scroll: there is nothing to navigate with it, the elapsed
  // time says where you are, and the gutter it occupies is reserved either way, so nothing reflows
  // when it appears on taking over.
  const showScrollbar = scrollable && !(synced && following);
  const [thumbTop, thumbBottom] = showScrollbar
    ? thumbRange(display.length, viewport, offset)
    : [0, 0];

  // Where the page is in settling onto the current line. 1 means it has arrived.
  const settle = easeOut(fadeProgress(lines, current, now));

  const status = (() => {
    if (error !== null) return error;
    if (loading) return "searching for lyrics…";
    if (lyrics === null) return "no lyrics";
    const origin = lyrics.source === "lrclib" ? "lrclib.net" : "genius.com";

    // While it follows, a scroll range says nothing — the view is driving itself. The elapsed time
    // is worth more there, because the HUD that normally shows it is hidden behind this overlay.
    const lead =
      synced && following && item !== null
        ? `${formatDuration(Math.max(0, now))} / ${formatDuration(item.duration_ms)}`
        : scrollable
          ? `${offset + 1}–${Math.min(display.length, offset + viewport)} of ${display.length}`
          : "";

    // The same budget the shell truncates at, so parts are dropped before it has to cut one.
    return fitStatus([lead, lyrics.artists.toLowerCase(), origin], inner - 30);
  })();

  const hints = (() => {
    if (error !== null) return "r retry · esc close";
    if (synced && !following) return "↑↓ scroll · f follow · esc close";
    return "↑↓ scroll · esc close";
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
      hints={hints}
      onMouseScroll={handleMouseScroll}
    >
      {visible.map((row, index) => {
        const inThumb = index >= thumbTop && index < thumbBottom;

        // Every visible row shifts one step down the falloff when the line changes, so the whole
        // page moves at once. Blending from where the row was to where it is now turns that from a
        // snap into a settle — the single biggest visual event in the overlay.
        const distance = distanceFrom(row.line, current, synced);
        const wasDistance = distanceFrom(row.line, current - 1, synced);
        const lineColor =
          settle >= 1
            ? colorFor(distance)
            : lerpColor(colorFor(wasDistance), colorFor(distance), settle);

        // The same marker the palette puts against its selected row, so "this is the one" reads the
        // same way everywhere in the app. On a stamped blank line — an instrumental gap — it is all
        // that shows, which is exactly right: the song is still going, nobody is singing.
        const marker = row.line === current && offset + index === currentRow ? "▌" : " ";
        const markerColor = lerpColor(theme.faint, theme.accent, settle);
        const pad = " ".repeat((row.continuation ? INDENT + 2 : INDENT) - 1);

        const sectionTo = !synced || row.line === current ? theme.accent : theme.label;
        const sectionFrom = !synced || row.line === current - 1 ? theme.accent : theme.label;

        return (
          <box key={`${offset + index}`} flexDirection="row">
            {row.text.length === 0 ? (
              <text fg={markerColor}>{marker}</text>
            ) : row.section ? (
              <text fg={settle >= 1 ? sectionTo : lerpColor(sectionFrom, sectionTo, settle)}>
                <strong>{`${marker}${pad}${row.text}`}</strong>
              </text>
            ) : (
              <text>
                <span fg={markerColor}>{marker}</span>
                <span fg={lineColor}>{`${pad}${row.text}`}</span>
              </text>
            )}
            {showScrollbar ? (
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
