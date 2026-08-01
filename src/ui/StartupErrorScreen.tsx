import { brandedScreenLayout, BrandLockup } from "./Brand.tsx";
import { theme } from "./theme.ts";
import { truncate, wrap } from "./text.ts";

const SCREEN_PADDING_X = 2;
const SCREEN_PADDING_Y = 1;
const MESSAGE_GAP = 1;
const FOOTER_GAP = 1;
const HEADING_LINES = ["Startup failed."] as const;
const FOOTER_LINES = ["R to retry.", "Q to quit."] as const;

export interface StartupErrorLayout {
  innerWidth: number;
  innerHeight: number;
  brandHeight: number;
  brandGapHeight: number;
  messageLines: string[];
  messageGapHeight: number;
  footerGapHeight: number;
}

/** Measure the complete error surface before spending any rows on branding. */
export function startupErrorLayout(
  message: string,
  width: number,
  height: number,
): StartupErrorLayout {
  const innerWidth = Math.max(1, width - SCREEN_PADDING_X * 2);
  const innerHeight = Math.max(0, height - SCREEN_PADDING_Y * 2);
  const wrappedMessage = message.length > 0 ? wrap(message, innerWidth) : [];
  const messageGapHeight = wrappedMessage.length > 0 ? MESSAGE_GAP : 0;
  const footerGapHeight = FOOTER_GAP;
  const contentHeight =
    HEADING_LINES.length +
    messageGapHeight +
    wrappedMessage.length +
    footerGapHeight +
    FOOTER_LINES.length;
  const brand = brandedScreenLayout(
    width,
    height,
    contentHeight,
    SCREEN_PADDING_X,
    SCREEN_PADDING_Y,
  );
  const brandHeight = brand.brandHeight;
  const brandGapHeight = brand.gapHeight;
  const fixedHeight =
    brandHeight +
    brandGapHeight +
    HEADING_LINES.length +
    messageGapHeight +
    footerGapHeight +
    FOOTER_LINES.length;
  const visibleMessageCount = Math.max(0, innerHeight - fixedHeight);
  const messageLines = wrappedMessage.slice(0, visibleMessageCount);

  if (messageLines.length < wrappedMessage.length && messageLines.length > 0) {
    const last = messageLines.length - 1;
    messageLines[last] = truncate(`${messageLines[last]}…`, innerWidth);
  }

  return {
    innerWidth,
    innerHeight,
    brandHeight,
    brandGapHeight,
    messageLines,
    messageGapHeight: messageLines.length > 0 ? messageGapHeight : 0,
    footerGapHeight,
  };
}

export function StartupErrorScreen({
  message,
  width,
  height,
}: {
  message: string;
  width: number;
  height: number;
}) {
  const layout = startupErrorLayout(message, width, height);

  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={SCREEN_PADDING_X}
      paddingY={SCREEN_PADDING_Y}
      overflow="hidden"
    >
      {layout.brandHeight > 0 ? (
        <BrandLockup width={layout.innerWidth} maxHeight={layout.brandHeight} />
      ) : null}

      <box
        flexDirection="column"
        flexShrink={0}
        marginTop={layout.brandGapHeight}
        overflow="hidden"
      >
        <text fg={theme.error}>{HEADING_LINES[0]}</text>
        {layout.messageLines.length > 0 ? (
          <box
            flexDirection="column"
            height={layout.messageLines.length}
            marginTop={layout.messageGapHeight}
            flexShrink={0}
          >
            {layout.messageLines.map((line, index) => (
              <text key={`${index}:${line}`} fg={theme.label}>
                {line}
              </text>
            ))}
          </box>
        ) : null}
      </box>

      <box flexGrow={1} flexShrink={1} />

      <box flexDirection="column" flexShrink={0} marginTop={layout.footerGapHeight}>
        {FOOTER_LINES.map((line) => (
          <text key={line} fg={theme.label}>
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}
