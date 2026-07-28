import { artistLine, isTrack, type PlayableItem, type RepeatState } from "../api/types.ts";
import { formatDuration, progressBar } from "../store/progress.ts";
import type { EngineStatus } from "../engine/librespot.ts";
import { theme } from "./theme.ts";

/**
 * Cell rows the HUD occupies at the bottom of the screen.
 *
 * Title, artist, album, a spacer, transport and the state line — six rows plus one of breathing
 * room. Must match the content exactly, or the scrim leaves a visible empty band.
 */
export const HUD_ROWS = 7;

function truncate(value: string, max: number): string {
  if (max <= 1) return "";
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const REPEAT_LABEL: Record<RepeatState, string> = { off: "OFF", track: "TRACK", context: "ALL" };

/** Top-left corner: identity and engine health, over the art. */
export function TopBar({
  engine,
  account,
  product,
  width,
}: {
  engine: EngineStatus;
  account: string;
  product: string | undefined;
  width: number;
}) {
  const engineOk = engine.state === "running";
  return (
    <box
      position="absolute"
      left={2}
      top={1}
      width={width - 4}
      zIndex={2}
      flexDirection="row"
      justifyContent="space-between"
    >
      <text>
        <span fg={theme.accent}>
          <strong>SPOTUIFY</strong>
        </span>
        <span fg={theme.scrimText}>{"  ·  "}</span>
        <span fg={engineOk ? theme.accent : theme.error}>{engineOk ? "ENGINE" : "NO ENGINE"}</span>
      </text>
      <text fg={theme.scrimText}>
        {account}
        {product !== undefined ? `  ·  ${product.toUpperCase()}` : ""}
      </text>
    </box>
  );
}

interface HudProps {
  item: PlayableItem;
  progressMs: number;
  durationMs: number;
  isPlaying: boolean;
  shuffle: boolean;
  repeat: RepeatState;
  volumePercent: number | null;
  deviceName: string | null;
  width: number;
  height: number;
}

/**
 * Bottom overlay: identity, transport, state.
 *
 * Sits on the darkened band of the backdrop, pinned to the bottom rows. Hierarchy is carried by
 * brightness — near-white title, muted artist, dim metadata — since the art behind it is busy.
 */
export function Hud({
  item,
  progressMs,
  durationMs,
  isPlaying,
  shuffle,
  repeat,
  volumePercent,
  deviceName,
  width,
  height,
}: HudProps) {
  const inner = width - 4;
  const barWidth = Math.max(8, inner - 16);
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, progressMs / durationMs)) : 0;
  const filled = Math.round(ratio * barWidth);
  const bar = progressBar(progressMs, durationMs, barWidth);

  const meta = [
    isPlaying ? "PLAYING" : "PAUSED",
    shuffle ? "SHUFFLE" : null,
    repeat === "off" ? null : `REPEAT ${REPEAT_LABEL[repeat]}`,
    deviceName,
    volumePercent === null ? null : `VOL ${volumePercent}%`,
  ]
    .filter((v): v is string => v !== null && v.length > 0)
    .join("   ·   ");

  return (
    <box
      position="absolute"
      left={2}
      top={height - HUD_ROWS}
      width={inner}
      zIndex={2}
      flexDirection="column"
    >
      <text fg={theme.text}>
        <strong>{truncate(item.name.toUpperCase(), inner)}</strong>
      </text>
      <text fg={theme.muted}>{truncate(artistLine(item), inner)}</text>
      <text fg={theme.scrimText}>{isTrack(item) ? truncate(item.album.name, inner) : ""}</text>

      <box marginTop={1} flexDirection="row" gap={1}>
        <text fg={isPlaying ? theme.accent : theme.muted}>{isPlaying ? "▶" : "❚❚"}</text>
        <text fg={theme.text}>{formatDuration(progressMs).padStart(5)}</text>
        <text>
          <span fg={theme.accent}>{bar.slice(0, filled)}</span>
          <span fg={theme.scrimBar}>{bar.slice(filled)}</span>
        </text>
        <text fg={theme.scrimText}>{formatDuration(durationMs).padStart(5)}</text>
      </box>

      <text fg={theme.scrimText}>{truncate(meta, inner)}</text>
    </box>
  );
}
