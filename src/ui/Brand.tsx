import { TAGLINE } from "../branding.ts";
import { theme } from "./theme.ts";
import { wrap } from "./text.ts";

const WORDMARK_WIDTH = 29;
const WORDMARK_HEIGHT = 2;

export type BrandLockupMode = "art" | "plain";

/** Render the OpenTUI wordmark art only when it fits without clipping. */
export function brandLockupMode(
  width: number,
  maxHeight = Number.POSITIVE_INFINITY,
): BrandLockupMode {
  return width >= WORDMARK_WIDTH && maxHeight >= WORDMARK_HEIGHT ? "art" : "plain";
}

export function brandLockupHeight(
  width: number,
  maxHeight = Number.POSITIVE_INFINITY,
): number {
  return brandLockupMode(width, maxHeight) === "art" ? WORDMARK_HEIGHT : 1;
}

export interface BrandedScreenLayout {
  innerWidth: number;
  innerHeight: number;
  brandHeight: number;
  gapHeight: number;
}

/** Give content its measured rows first, then choose the strongest brand treatment that remains. */
export function brandedScreenLayout(
  width: number,
  height: number,
  contentHeight: number,
  paddingX = 2,
  paddingY = 1,
): BrandedScreenLayout {
  const innerWidth = Math.max(1, width - paddingX * 2);
  const innerHeight = Math.max(0, height - paddingY * 2);
  const remainingHeight = Math.max(0, innerHeight - Math.max(0, contentHeight));
  const preferredGap = remainingHeight >= 2 ? 1 : 0;
  const brandBudget = Math.max(0, remainingHeight - preferredGap);
  const brandHeight =
    brandBudget > 0 ? brandLockupHeight(innerWidth, brandBudget) : 0;
  const gapHeight = brandHeight > 0 && remainingHeight > brandHeight ? 1 : 0;

  return { innerWidth, innerHeight, brandHeight, gapHeight };
}

export interface BrandSplashLayout {
  innerWidth: number;
  messageLines: string[];
  brandHeight: number;
  taglineHeight: number;
  taglineGapHeight: number;
  gapHeight: number;
  totalHeight: number;
  top: number;
}

/** Measure every row before positioning the fixed splash region. */
export function brandSplashLayout(
  message: string,
  width: number,
  height: number,
): BrandSplashLayout {
  const innerWidth = Math.max(1, width - 4);
  const availableHeight = Math.max(0, height);
  // Guidance is more important than decoration when the terminal is extremely short.
  const messageLines = wrap(message, innerWidth).slice(0, availableHeight);
  const remainingHeight = availableHeight - messageLines.length;
  const preferredGap = remainingHeight >= 2 ? 1 : 0;
  const brandBudget = Math.max(0, remainingHeight - preferredGap);
  const brandHeight =
    brandBudget > 0 ? brandLockupHeight(innerWidth, brandBudget) : 0;
  const gapHeight = brandHeight > 0 && remainingHeight > brandHeight ? 1 : 0;
  const untaggedHeight = brandHeight + gapHeight + messageLines.length;

  // Anchor on the wordmark's own centered row, not the splash region's. Centering the whole
  // region moved the brand whenever the message wrapped to a different number of rows. Only a
  // terminal too short to fit the message below the anchored brand pushes the wordmark up.
  const brandTop = Math.floor((availableHeight - brandHeight) / 2);
  const anchor = (total: number) =>
    Math.max(0, Math.min(brandTop, availableHeight - total));
  const top = anchor(untaggedHeight);

  // The tagline is decoration and yields to everything else. It appears only under a visible
  // wordmark, only when it fits on one row, and only when the extra row leaves the wordmark on
  // the row it already occupies — messages come and go, and the brand must not drift with them.
  // A blank row separates the tagline from the wordmark art, so the tagline costs two rows, not
  // one, and is dropped whole rather than rendered flush against the lockup.
  const taglineCost = 2;
  const taglineHeight =
    brandHeight > 0 &&
    wrap(TAGLINE, innerWidth).length === 1 &&
    untaggedHeight + taglineCost <= availableHeight &&
    anchor(untaggedHeight + taglineCost) === top
      ? 1
      : 0;

  return {
    innerWidth,
    messageLines,
    brandHeight,
    taglineHeight,
    taglineGapHeight: taglineHeight,
    gapHeight,
    totalHeight: untaggedHeight + taglineHeight * taglineCost,
    top,
  };
}

export function BrandLockup({
  width,
  maxHeight = Number.POSITIVE_INFINITY,
}: {
  width: number;
  maxHeight?: number;
}) {
  const mode = brandLockupMode(width, maxHeight);
  const height = brandLockupHeight(width, maxHeight);

  return (
    <box
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      overflow="hidden"
    >
      {mode === "art" ? (
        // Rendered in three segments so the TUI in spo·tui·fy carries the mark's second colour.
        // The single-column boxes replace the inter-letter gaps the font adds internally, so the
        // segments total exactly the width one "SPOTUIFY" call would have produced.
        <box flexDirection="row">
          <ascii-font text="SPO" font="tiny" color={theme.brand} selectable={false} />
          <box width={1} />
          <ascii-font text="TUI" font="tiny" color={theme.brandCream} selectable={false} />
          <box width={1} />
          <ascii-font text="FY" font="tiny" color={theme.brand} selectable={false} />
        </box>
      ) : (
        <text fg={theme.brand}>
          <strong>SPO</strong>
          <span fg={theme.brandCream}>
            <strong>TUI</strong>
          </span>
          <strong>FY</strong>
        </text>
      )}
    </box>
  );
}

export function BrandSplash({
  message,
  width,
  height,
}: {
  message: string;
  width: number;
  height: number;
}) {
  const layout = brandSplashLayout(message, width, height);
  if (layout.totalHeight === 0) return null;

  return (
    <box
      position="absolute"
      left={2}
      top={layout.top}
      width={layout.innerWidth}
      height={layout.totalHeight}
      zIndex={2}
      flexDirection="column"
      alignItems="center"
      overflow="hidden"
    >
      {layout.brandHeight > 0 ? (
        <BrandLockup width={layout.innerWidth} maxHeight={layout.brandHeight} />
      ) : null}
      {layout.taglineHeight > 0 ? (
        <box
          width={layout.innerWidth}
          height={layout.taglineHeight}
          marginTop={layout.taglineGapHeight}
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          overflow="hidden"
        >
          <text fg={theme.label} selectable={false}>
            {TAGLINE}
          </text>
        </box>
      ) : null}
      {layout.messageLines.length > 0 ? (
        <box
          width={layout.innerWidth}
          height={layout.messageLines.length}
          marginTop={layout.gapHeight}
          flexDirection="column"
          alignItems="center"
          flexShrink={0}
          overflow="hidden"
        >
          {layout.messageLines.map((line, index) => (
            <text key={`${index}:${line}`} fg={theme.muted}>
              {line}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  );
}
