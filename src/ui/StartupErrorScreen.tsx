import { brandedScreenLayout, BrandLockup } from "./Brand.tsx";
import { theme } from "./theme.ts";
import { truncate, wrap } from "./text.ts";

const SCREEN_PADDING_X = 2;
const SCREEN_PADDING_Y = 1;
const MESSAGE_GAP = 1;
const FOOTER_GAP = 1;
const HEADING_LINES = ["Startup failed."] as const;
const FOOTER_LINES = ["r to retry.", "q to quit."] as const;

export interface StartupErrorLayout {
  innerWidth: number;
  innerHeight: number;
  brandHeight: number;
  brandGapHeight: number;
  headingLines: string[];
  messageLines: string[];
  messageGapHeight: number;
  footerGapHeight: number;
  footerLines: string[];
}

/** Measure the complete error surface before spending any rows on branding. */
export function startupErrorLayout(
  message: string,
  width: number,
  height: number,
): StartupErrorLayout {
  const innerWidth = Math.max(1, width - SCREEN_PADDING_X * 2);
  const innerHeight = Math.max(0, height - SCREEN_PADDING_Y * 2);
  const headingLines = HEADING_LINES.flatMap((line) => wrap(line, innerWidth));
  const wrappedMessage = message.length > 0 ? wrap(message, innerWidth) : [];
  const footerLines = FOOTER_LINES.flatMap((line) => wrap(line, innerWidth));
  const mandatoryHeight = headingLines.length + footerLines.length;
  const preferredMessageGap = wrappedMessage.length > 0 ? MESSAGE_GAP : 0;
  const preferredContentHeight =
    mandatoryHeight +
    preferredMessageGap +
    wrappedMessage.length +
    FOOTER_GAP;
  const brand = brandedScreenLayout(
    width,
    height,
    preferredContentHeight,
    SCREEN_PADDING_X,
    SCREEN_PADDING_Y,
  );
  const brandHeight = brand.brandHeight;
  const brandGapHeight = brand.gapHeight;
  let availableHeight = Math.max(
    0,
    innerHeight - brandHeight - brandGapHeight - mandatoryHeight,
  );
  const visibleMessageCount = Math.min(wrappedMessage.length, availableHeight);
  const messageLines = wrappedMessage.slice(0, visibleMessageCount);
  availableHeight -= visibleMessageCount;
  const messageGapHeight =
    messageLines.length > 0 ? Math.min(MESSAGE_GAP, availableHeight) : 0;
  availableHeight -= messageGapHeight;
  const footerGapHeight = Math.min(FOOTER_GAP, availableHeight);

  if (messageLines.length < wrappedMessage.length && messageLines.length > 0) {
    const last = messageLines.length - 1;
    messageLines[last] = truncate(`${messageLines[last]}…`, innerWidth);
  }

  return {
    innerWidth,
    innerHeight,
    brandHeight,
    brandGapHeight,
    headingLines,
    messageLines,
    messageGapHeight,
    footerGapHeight,
    footerLines,
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
        <box
          flexDirection="column"
          height={layout.headingLines.length}
          flexShrink={0}
          overflow="hidden"
        >
          {layout.headingLines.map((line, index) => (
            <text key={`${index}:${line}`} fg={theme.error}>
              {line}
            </text>
          ))}
        </box>
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
        {layout.footerLines.map((line, index) => (
          <text key={`${index}:${line}`} fg={theme.label}>
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}
