import { create } from "zustand";
import type { PlayerApi } from "../api/player.ts";
import type { Device } from "../api/types.ts";
import { DEVICE_NAME } from "../config.ts";
import { LibrespotEngine } from "../engine/librespot.ts";
import { usePlayback } from "./playback.ts";

/** Reopening the picker should not spend another request for a list that just succeeded. */
export const DEVICE_CACHE_TTL_MS = 15_000;

export interface DeviceSlice {
  open: boolean;
  devices: Device[];
  selected: number;
  loading: boolean;
  error: string | null;

  configure: (
    player: PlayerApi,
    engine?: LibrespotEngine | null,
    accountId?: string | null,
  ) => void;
  openPicker: () => void;
  closePicker: () => void;
  move: (delta: number) => void;
  /** Transfer playback to the highlighted device. Resolves once the transfer is acknowledged. */
  activate: () => Promise<void>;
  current: () => Device | null;
}

let player: PlayerApi | null = null;
let native: LibrespotEngine | null = null;
let webAccountId: string | null = null;
let inFlight: AbortController | null = null;
let cachedRemoteDevices: Device[] | null = null;
let cachedAt = 0;

function localDevice(): Device | null {
  const status = native?.getStatus();
  if (
    webAccountId === null ||
    status?.state !== "ready" ||
    status.accountId !== webAccountId
  ) {
    return null;
  }
  const playback = usePlayback.getState();
  return {
    id: status.deviceId,
    name: DEVICE_NAME,
    type: "Computer",
    is_active: (native?.isActive?.() ?? false) && playback.deviceId === status.deviceId,
    is_restricted: false,
    volume_percent: playback.volumePercent,
    supports_volume: true,
  };
}

/**
 * Spotify's remote device list with the embedded receiver prepended when it is usable.
 *
 * The receiver is not always present in `/me/player/devices`, so any surface resolving a device
 * selector must merge it in — otherwise the local receiver cannot be targeted by name or ID.
 */
export function withLocalDevice(devices: Device[]): Device[] {
  const local = localDevice();
  if (local === null) return devices;
  return [
    local,
    ...devices.filter((device) => device.id !== local.id),
  ];
}

/** The account-matched, ready embedded receiver's device ID, or null when it cannot be routed. */
export function localReceiverId(): string | null {
  return localDevice()?.id ?? null;
}

/**
 * Transfer playback to a resolved device, routing the embedded receiver through librespot.
 *
 * A Web API transfer aimed at our own receiver would sidestep the native activation path while
 * `confirmDeviceTransfer` marks the move as externally confirmed — exactly the state mix the
 * account-match and ID-identity rules exist to prevent. Local routing applies only when the
 * librespot and Web API accounts match; everything else goes through Spotify with the transfer
 * confirmed into the playback store.
 */
export async function transferPlayback(
  device: Device & { id: string },
  play: boolean,
  webPlayer?: PlayerApi,
): Promise<void> {
  const status = native?.getStatus();
  if (
    webAccountId !== null &&
    status?.state === "ready" &&
    status.accountId === webAccountId &&
    device.id === status.deviceId
  ) {
    await native!.transfer();
    // Native transfer preserves the paused/playing state; only an explicit play request resumes.
    if (play && !usePlayback.getState().isPlaying) {
      await usePlayback.getState().togglePlay();
    }
    return;
  }
  const target = webPlayer ?? player;
  if (target === null) throw new Error("no web player is configured for device transfer");
  await target.transfer(device.id, play);
  usePlayback.getState().confirmDeviceTransfer(device.id, device.name);
}

/**
 * Index of the device to highlight on open.
 *
 * Prefers the active one so the list opens on where audio is actually going; otherwise the first
 * device that can be targeted at all.
 */
function initialIndex(devices: Device[]): number {
  const active = devices.findIndex((d) => d.is_active);
  if (active >= 0) return active;
  return devices.findIndex((d) => d.id !== null && !d.is_restricted);
}

export const useDevices = create<DeviceSlice>((set, get) => ({
  open: false,
  devices: [],
  selected: -1,
  loading: false,
  error: null,

  configure(nextPlayer, engine, accountId = null) {
    const playerChanged = player !== nextPlayer;
    const accountChanged = webAccountId !== accountId;
    if (playerChanged || accountChanged) {
      inFlight?.abort();
      inFlight = null;
      cachedRemoteDevices = null;
      cachedAt = 0;
      set({ open: false, devices: [], selected: -1, loading: false, error: null });
    }
    if (engine !== undefined) {
      native = engine;
    } else if (playerChanged) {
      native = null;
    }
    player = nextPlayer;
    webAccountId = accountId;
  },

  openPicker() {
    const cacheIsFresh =
      cachedRemoteDevices !== null && Date.now() - cachedAt < DEVICE_CACHE_TTL_MS;
    const initial = withLocalDevice(cacheIsFresh ? cachedRemoteDevices! : []);
    set({
      open: true,
      devices: initial,
      selected: initialIndex(initial),
      loading: !cacheIsFresh,
      error: null,
    });
    if (player === null || cacheIsFresh) return;

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    void (async () => {
      try {
        const remoteDevices = await player!.devices(controller.signal);
        if (controller.signal.aborted) return;
        cachedRemoteDevices = remoteDevices;
        cachedAt = Date.now();
        const devices = withLocalDevice(remoteDevices);
        set({ devices, selected: initialIndex(devices), loading: false });
      } catch (err) {
        if (controller.signal.aborted) return;
        const devices = withLocalDevice([]);
        set({
          devices,
          selected: initialIndex(devices),
          loading: false,
          // The native receiver remains usable even if Spotify's optional remote-device read fails.
          error: devices.length > 0 ? null : err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    })();
  },

  closePicker() {
    inFlight?.abort();
    inFlight = null;
    set({ open: false, devices: [], selected: -1, loading: false, error: null });
  },

  move(delta) {
    const { devices, selected } = get();
    if (devices.length === 0) return;
    // Restricted devices and those without an id cannot be targeted, so skip over them.
    const usable = devices
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.id !== null && !d.is_restricted)
      .map(({ i }) => i);
    if (usable.length === 0) return;

    const at = usable.indexOf(selected);
    const next = at < 0 ? 0 : Math.min(usable.length - 1, Math.max(0, at + (delta > 0 ? 1 : -1)));
    set({ selected: usable[next] ?? selected });
  },

  async activate() {
    const device = get().current();
    if (player === null || device?.id == null) return;

    set({ loading: true, error: null });
    try {
      // Keep whatever the playback state was; transferring should not start music by itself.
      await transferPlayback(device as Device & { id: string }, false);
      // Active flags changed. Do not show a stale cached list on the next open.
      cachedRemoteDevices = null;
      cachedAt = 0;
      set({ open: false, devices: [], selected: -1, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  current() {
    const { devices, selected } = get();
    return devices[selected] ?? null;
  },
}));
