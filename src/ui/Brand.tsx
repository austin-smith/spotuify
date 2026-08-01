import { theme } from "./theme.ts";

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
  const innerWidth = Math.max(1, width - 4);
  const maxBrandHeight = Math.max(1, height - 2);
  const brandHeight = brandLockupHeight(innerWidth, maxBrandHeight);
  const totalHeight = brandHeight + 2;

  return (
    <box
      position="absolute"
      left={2}
      top={Math.max(0, Math.floor((height - totalHeight) / 2))}
      width={innerWidth}
      height={totalHeight}
      zIndex={2}
      flexDirection="column"
      alignItems="center"
      overflow="hidden"
    >
      <BrandLockup width={innerWidth} maxHeight={maxBrandHeight} />
      <text fg={theme.muted} marginTop={1}>
        {message}
      </text>
    </box>
  );
}
