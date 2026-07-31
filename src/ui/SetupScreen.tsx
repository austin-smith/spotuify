import { engineSetupCommand } from "../engine/librespot.ts";
import { theme } from "./theme.ts";

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
  return (
    <box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={2}
      paddingY={1}
      overflow="hidden"
    >
      <box flexDirection="column" flexShrink={1} minHeight={1} overflow="hidden">
        <text fg={theme.accent} flexShrink={0}>
          <strong>SPOTUIFY</strong>
        </text>
        <box flexDirection="column" flexShrink={0} marginTop={1}>
          <text fg={theme.text}>Setup required.</text>
          <text fg={theme.label} marginTop={1}>
            Run <span fg={theme.text}>{authCommand}</span> to get started.
          </text>
        </box>
      </box>

      <box flexGrow={1} flexShrink={1} />

      <box flexDirection="column" flexShrink={0} marginTop={1}>
        {updateAvailable ? (
          <text fg={theme.accent}>Update available — run: spotuify update</text>
        ) : null}
        <text fg={theme.label} marginTop={updateAvailable ? 1 : 0}>
          Q to quit.
        </text>
      </box>
    </box>
  );
}
