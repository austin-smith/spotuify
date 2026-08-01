import { theme } from "./theme.ts";
import { wrap } from "./text.ts";

const WORDMARK_WIDTH = 70;
const WORDMARK_HEIGHT = 6;

export type BrandLockupMode = "block" | "plain";

/** Render the OpenTUI block wordmark only when it fits without clipping. */
export function brandLockupMode(
  width: number,
  maxHeight = Number.POSITIVE_INFINITY,
): BrandLockupMode {
  return width >= WORDMARK_WIDTH && maxHeight >= WORDMARK_HEIGHT ? "block" : "plain";
}

export function brandLockupHeight(
  width: number,
  maxHeight = Number.POSITIVE_INFINITY,
): number {
  return brandLockupMode(width, maxHeight) === "block" ? WORDMARK_HEIGHT : 1;
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
  const totalHeight = brandHeight + gapHeight + messageLines.length;

  return {
    innerWidth,
    messageLines,
    brandHeight,
    gapHeight,
    totalHeight,
    top: Math.max(0, Math.floor((availableHeight - totalHeight) / 2)),
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
      {mode === "block" ? (
        <ascii-font
          text="SPOTUIFY"
          font="block"
          color={theme.brand}
          selectable={false}
        />
      ) : (
        <text fg={theme.brand}>
          <strong>SPOTUIFY</strong>
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
