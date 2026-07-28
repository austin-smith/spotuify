import type { Device } from "../api/types.ts";
import { useDevices } from "../store/devices.ts";
import { meter } from "../store/progress.ts";
import { Overlay, OverlayTitle, overlayInnerWidth, overlayListHeight } from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Short label for the device type Spotify reports. */
function kindOf(device: Device): string {
  return device.type.toLowerCase();
}

function DeviceRow({
  device,
  selected,
  width,
}: {
  device: Device;
  selected: boolean;
  width: number;
}) {
  const targetable = device.id !== null && !device.is_restricted;
  const nameWidth = Math.max(10, Math.floor(width * 0.5));
  const volume =
    device.volume_percent === null ? "" : `${meter(device.volume_percent, 100, 8)} ${device.volume_percent}%`;

  return (
    <box flexDirection="row" gap={1}>
      <text fg={selected ? theme.accent : theme.faint}>{selected ? "▌" : " "}</text>
      <text fg={device.is_active ? theme.accent : theme.faint}>{device.is_active ? "●" : "○"}</text>
      <text fg={targetable ? (selected ? theme.text : theme.muted) : theme.faint}>
        {truncate(device.name, nameWidth).padEnd(nameWidth)}
      </text>
      <text fg={theme.label}>{kindOf(device).padEnd(10)}</text>
      <text fg={theme.label}>{targetable ? volume : "unavailable"}</text>
    </box>
  );
}

/**
 * Device chooser, overlaid on the dimmed cover.
 *
 * Restricted devices are listed but dimmed and skipped by navigation: Spotify reports them, yet
 * transferring to them fails.
 */
export function DevicePicker({ width, height }: { width: number; height: number }) {
  const devices = useDevices((s) => s.devices);
  const selected = useDevices((s) => s.selected);
  const loading = useDevices((s) => s.loading);
  const error = useDevices((s) => s.error);

  const inner = overlayInnerWidth(width);
  const listHeight = overlayListHeight(height);

  const status = (() => {
    if (error !== null) return error;
    if (loading) return "…";
    if (devices.length === 0) return "no devices found — open Spotify somewhere, or start the engine";
    const active = devices.find((d) => d.is_active);
    return active === undefined ? "nothing is active" : `playing on ${active.name}`;
  })();

  return (
    <Overlay
      width={width}
      height={height}
      header={<OverlayTitle glyph="◈" title="DEVICES" />}
      status={status}
      hints="↑↓ move · ↵ switch · esc close"
      isError={error !== null}
    >
      {devices.slice(0, listHeight).map((device, index) => (
        <DeviceRow
          key={device.id ?? `${device.name}-${index}`}
          device={device}
          selected={index === selected}
          width={inner}
        />
      ))}
    </Overlay>
  );
}
