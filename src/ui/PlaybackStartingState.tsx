import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Fallback for context selections that do not carry a concrete track preview. */
export function PlaybackStartingState({
  label,
  width,
  height,
}: {
  label: string;
  width: number;
  height: number;
}) {
  const innerWidth = Math.max(1, width - 4);
  return (
    <box
      position="absolute"
      left={2}
      top={Math.max(0, Math.floor((height - 2) / 2))}
      width={innerWidth}
      height={2}
      flexDirection="column"
      alignItems="center"
      zIndex={2}
      overflow="hidden"
    >
      <text fg={theme.brand}>
        <strong>STARTING…</strong>
      </text>
      <text fg={theme.muted}>{truncate(label, innerWidth)}</text>
    </box>
  );
}
