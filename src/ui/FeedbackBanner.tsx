import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

const HORIZONTAL_PADDING = 1;

/** Rows reserved for the transient feedback itself. */
export const FEEDBACK_ROWS = 1;

/** Deliberate breathing room between transient feedback and the HUD. */
export const FEEDBACK_HUD_GAP_ROWS = 1;

/** First row for feedback placed immediately above the HUD. */
export function feedbackTopAboveHud(hudTop: number): number {
  return Math.max(0, hudTop - FEEDBACK_ROWS - FEEDBACK_HUD_GAP_ROWS);
}

interface FeedbackBannerProps {
  message: string;
  kind: "success" | "error" | "info";
  width: number;
  top: number;
  /** Screen column where the message text, rather than its backing, begins. */
  textLeft: number;
}

/**
 * Transient playback and write feedback drawn over the current screen.
 *
 * The opaque backing is functional, not decoration. OpenTUI leaves transparent space cells
 * untouched, so a bare text overlay can reveal letters or half-block artwork beneath the spaces
 * inside its message.
 */
export function FeedbackBanner({
  message,
  kind,
  width,
  top,
  textLeft,
}: FeedbackBannerProps) {
  const boxLeft = Math.max(0, textLeft - HORIZONTAL_PADDING);
  const leadingPadding = Math.max(0, textLeft - boxLeft);
  const maxBannerWidth = Math.max(0, width - boxLeft - HORIZONTAL_PADDING);
  const content = truncate(
    message,
    Math.max(0, maxBannerWidth - leadingPadding - HORIZONTAL_PADDING),
  );
  if (content.length === 0) return null;

  return (
    <box
      position="absolute"
      left={boxLeft}
      top={Math.max(0, top)}
      width={Math.min(
        maxBannerWidth,
        Bun.stringWidth(content) + leadingPadding + HORIZONTAL_PADDING,
      )}
      height={FEEDBACK_ROWS}
      zIndex={20}
      overflow="hidden"
      paddingLeft={leadingPadding}
      paddingRight={HORIZONTAL_PADDING}
      backgroundColor={theme.feedbackBackground}
    >
      <text fg={kind === "error" ? theme.error : theme.accent}>{content}</text>
    </box>
  );
}
