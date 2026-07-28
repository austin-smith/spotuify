import { create } from "zustand";
import type { PlayerApi } from "../api/player.ts";
import type { Device } from "../api/types.ts";

export interface DeviceSlice {
  open: boolean;
  devices: Device[];
  selected: number;
  loading: boolean;
  error: string | null;

  configure: (player: PlayerApi) => void;
  openPicker: () => void;
  closePicker: () => void;
  move: (delta: number) => void;
  /** Transfer playback to the highlighted device. Resolves once the transfer is acknowledged. */
  activate: () => Promise<void>;
  current: () => Device | null;
}

let player: PlayerApi | null = null;
let inFlight: AbortController | null = null;

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

  configure(nextPlayer) {
    player = nextPlayer;
  },

  openPicker() {
    set({ open: true, loading: true, error: null });
    if (player === null) return;

    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    void (async () => {
      try {
        const devices = await player!.devices();
        if (controller.signal.aborted) return;
        set({ devices, selected: initialIndex(devices), loading: false });
      } catch (err) {
        if (controller.signal.aborted) return;
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
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
      await player.transfer(device.id, false);
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
