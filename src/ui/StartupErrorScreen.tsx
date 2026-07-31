import { theme } from "./theme.ts";

export function StartupErrorScreen({
  message,
  width,
  height,
}: {
  message: string;
  width: number;
  height: number;
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
      <text fg={theme.accent} flexShrink={0}>
        <strong>SPOTUIFY</strong>
      </text>

      <box flexDirection="column" flexShrink={1} minHeight={1} marginTop={1} overflow="hidden">
        <text fg={theme.error} flexShrink={0}>
          Startup failed.
        </text>
        <text fg={theme.label} marginTop={1}>
          {message}
        </text>
      </box>

      <box flexGrow={1} flexShrink={1} />

      <box flexDirection="column" flexShrink={0} marginTop={1}>
        <text fg={theme.label}>R to retry.</text>
        <text fg={theme.label}>Q to quit.</text>
      </box>
    </box>
  );
}
