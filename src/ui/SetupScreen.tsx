import { engineSetupCommand } from "../engine/librespot.ts";
import { brandedScreenLayout, BrandLockup } from "./Brand.tsx";
import { theme } from "./theme.ts";
import { wrap } from "./text.ts";

const SCREEN_PADDING_X = 2;
const SCREEN_PADDING_Y = 1;
const INSTRUCTION_GAP = 1;
const FOOTER_GAP = 1;
const QUIT_GAP = 1;
const HEADING = "Setup required.";
const UPDATE_NOTICE = "Update available — run: spotuify update";
const QUIT_HINT = "q to quit.";

export interface SetupScreenLayout {
  innerWidth: number;
  brandHeight: number;
  brandGapHeight: number;
  headingLines: string[];
  instructionHeight: number;
  instructionGapHeight: number;
  updateHeight: number;
  footerGapHeight: number;
  quitHeight: number;
  quitGapHeight: number;
}

function setupInstruction(authCommand: string): string {
  return `Run ${authCommand} to get started.`;
}

/** Measure the complete setup handoff and footer before allocating optional branding rows. */
export function setupScreenLayout(
  authCommand: string,
  updateAvailable: boolean,
  width: number,
  height: number,
): SetupScreenLayout {
  const innerWidth = Math.max(1, width - SCREEN_PADDING_X * 2);
  const innerHeight = Math.max(0, height - SCREEN_PADDING_Y * 2);
  const headingLines = wrap(HEADING, innerWidth);
  const instructionHeight = wrap(setupInstruction(authCommand), innerWidth).length;
  const updateHeight = updateAvailable ? wrap(UPDATE_NOTICE, innerWidth).length : 0;
  const quitHeight = wrap(QUIT_HINT, innerWidth).length;
  const mandatoryHeight =
    headingLines.length +
    instructionHeight +
    updateHeight +
    quitHeight;
  let gapBudget = Math.max(0, innerHeight - mandatoryHeight);
  const instructionGapHeight = Math.min(INSTRUCTION_GAP, gapBudget);
  gapBudget -= instructionGapHeight;
  const footerGapHeight = Math.min(FOOTER_GAP, gapBudget);
  gapBudget -= footerGapHeight;
  const quitGapHeight = updateHeight > 0 ? Math.min(QUIT_GAP, gapBudget) : 0;
  const contentHeight =
    mandatoryHeight + instructionGapHeight + footerGapHeight + quitGapHeight;
  const brand = brandedScreenLayout(
    width,
    height,
    contentHeight,
    SCREEN_PADDING_X,
    SCREEN_PADDING_Y,
  );

  return {
    innerWidth,
    brandHeight: brand.brandHeight,
    brandGapHeight: brand.gapHeight,
    headingLines,
    instructionHeight,
    instructionGapHeight,
    updateHeight,
    footerGapHeight,
    quitHeight,
    quitGapHeight,
  };
}

export function SetupScreen({
  updateAvailable,
  width,
  height,
  authCommand = engineSetupCommand(),
}: {
  updateAvailable: boolean;
  width: number;
  height: number;
  authCommand?: string;
}) {
  const layout = setupScreenLayout(authCommand, updateAvailable, width, height);

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
      <box flexDirection="column" flexShrink={0} marginTop={layout.brandGapHeight}>
        <box
          flexDirection="column"
          height={layout.headingLines.length}
          flexShrink={0}
          overflow="hidden"
        >
          {layout.headingLines.map((line, index) => (
            <text key={`${index}:${line}`} fg={theme.text}>
              {line}
            </text>
          ))}
        </box>
        <box
          height={layout.instructionHeight}
          flexShrink={0}
          marginTop={layout.instructionGapHeight}
          overflow="hidden"
        >
          <text fg={theme.label}>
            Run <span fg={theme.text}>{authCommand}</span> to get started.
          </text>
        </box>
      </box>

      <box flexGrow={1} flexShrink={1} />

      <box flexDirection="column" flexShrink={0} marginTop={layout.footerGapHeight}>
        {updateAvailable ? (
          <box height={layout.updateHeight} flexShrink={0} overflow="hidden">
            <text fg={theme.accent}>{UPDATE_NOTICE}</text>
          </box>
        ) : null}
        <box
          height={layout.quitHeight}
          flexShrink={0}
          marginTop={layout.quitGapHeight}
          overflow="hidden"
        >
          <text fg={theme.label}>{QUIT_HINT}</text>
        </box>
      </box>
    </box>
  );
}
