import type { MouseEvent } from "@opentui/core";
import type { ReactNode } from "react";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Horizontal inset of every overlay. */
export const OVERLAY_PADDING_X = 4;

/**
 * Vertical inset of every overlay.
 *
 * Also the screen row the header sits on, which the cover backdrop needs in order to flatten the
 * cells under the palette's caret.
 */
export const OVERLAY_TOP = 2;

/**
 * Rows the shell itself owns, counted from what it renders: two of padding at each end, the header,
 * the rule with its margin above, the margin above the list, and the footer.
 *
 * Verified against the renderer rather than counted by hand — it was one too low, so every overlay
 * asked for one row more than it had and the renderer drew the last two on top of each other. The
 * symptom was a single garbled row at the bottom of a full list, which reads as a font problem
 * rather than a layout one.
 */
const CHROME_ROWS = 9;

/** Usable width inside the padding. */
export function overlayInnerWidth(width: number): number {
  return width - OVERLAY_PADDING_X * 2;
}

/**
 * Rows a list can occupy, given the shell and any extra blocks above it.
 *
 * Each overlay used to carry its own `CHROME_ROWS` constant and subtract a different fudge factor,
 * so the same shell produced four slightly different list heights.
 */
export function overlayListHeight(height: number, extraRows = 0): number {
  return Math.max(1, height - CHROME_ROWS - extraRows);
}

/**
 * Rows a wheel/trackpad event asks to move by, signed, or null for non-scroll mouse input.
 *
 * Shared by every overlay that accepts wheel input so a tick means the same distance everywhere.
 * What that movement does — shift a scroll offset or walk a selection — stays with the overlay,
 * because those are different models and only the overlay knows which one it has.
 */
export function scrollSteps(event: MouseEvent): number | null {
  const direction = event.scroll?.direction;
  if (direction !== "up" && direction !== "down") return null;
  const rows = Math.max(1, Math.trunc(event.scroll?.delta ?? 1));
  return direction === "up" ? -rows : rows;
}

/** The `◈ TITLE` header most overlays use. */
export function OverlayTitle({ glyph, title }: { glyph: string; title: string }) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.accent}>
        <strong>{glyph}</strong>
      </text>
      <text fg={theme.text}>
        <strong>{title}</strong>
      </text>
    </box>
  );
}

interface OverlayProps {
  width: number;
  height: number;
  /** The header row: usually an `OverlayTitle`, or the palette's prompt. */
  header: ReactNode;
  /** Bottom left: what the list is showing, or why it is empty. */
  status: string;
  /** Bottom right: the keys this overlay answers to. */
  hints: string;
  /** Renders `status` as an error. */
  isError?: boolean;
  /** Handles wheel/trackpad input while the pointer is over the list viewport. */
  onMouseScroll?: (event: MouseEvent) => void;
  children: ReactNode;
}

/**
 * Shared shell for the overlays that cover the cover art.
 *
 * Full-bleed rather than a centered dialog: these are lists you navigate, and their length varies
 * with their contents. The one centered overlay is the keymap, which is a fixed reference card.
 */
export function Overlay({
  width,
  height,
  header,
  status,
  hints,
  isError = false,
  onMouseScroll,
  children,
}: OverlayProps) {
  const inner = overlayInnerWidth(width);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={10}
      flexDirection="column"
      paddingX={OVERLAY_PADDING_X}
      paddingY={OVERLAY_TOP}
    >
      {header}

      <box marginTop={1}>
        <text fg={theme.faint}>{"─".repeat(Math.max(0, inner))}</text>
      </box>

      <box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        marginTop={1}
        onMouseScroll={onMouseScroll}
      >
        {children}
      </box>

      <box flexDirection="row" justifyContent="space-between">
        <text fg={isError ? theme.error : theme.label}>{truncate(status, inner - 30)}</text>
        <text fg={theme.faint}>{hints}</text>
      </box>
    </box>
  );
}
