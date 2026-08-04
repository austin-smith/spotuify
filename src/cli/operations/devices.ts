import type { Device } from "../../api/types.ts";
import { tryRuntimeRequest } from "../../runtime/control.ts";
import { unavailable } from "../errors.ts";
import { normalizeRuntimePlayback } from "../output.ts";
import { cliSession } from "../session.ts";
import { allDevices, currentState, table, uniqueDevice } from "../support.ts";
import type { OperationResult } from "./types.ts";

export async function deviceList(): Promise<OperationResult<Device[]>> {
  // The runtime's merged view when available: it includes the embedded receiver, which
  // Spotify's device list does not always report. The listing must match what is targetable.
  const devices = await allDevices();
  return {
    data: devices,
    message: table(
      ["ACTIVE", "NAME", "TYPE", "VOLUME", "ID"],
      devices.map((item) => [
        item.is_active ? "*" : "",
        item.name,
        item.type,
        item.volume_percent === null ? "—" : `${item.volume_percent}%`,
        item.id,
      ]),
    ),
  };
}

export async function deviceCurrent(): Promise<OperationResult<unknown>> {
  // While the receiver is active, native transfer events outrun `/me/player`; the runtime
  // snapshot is the authority when one exists.
  const runtime = await tryRuntimeRequest("status");
  if (runtime.connected) {
    const device = normalizeRuntimePlayback(runtime.value)["device"] as {
      id: string | null;
      name: string;
      type: string | null;
    } | null;
    if (device === null) throw unavailable("No active playback device.");
    return {
      data: device,
      message: `${device.name}${device.type === null ? "" : ` (${device.type})`}\n${device.id ?? "No device ID"}`,
    };
  }
  const state = await currentState();
  if (state?.device === null || state?.device === undefined)
    throw unavailable("No active playback device.");
  return {
    data: state.device,
    message: `${state.device.name} (${state.device.type})\n${state.device.id ?? "No device ID"}`,
  };
}

export async function deviceTransfer(
  selector: string,
  play: boolean,
): Promise<OperationResult<Record<string, unknown>>> {
  const runtime = await tryRuntimeRequest("device.transfer", {
    selector,
    play,
  });
  if (runtime.connected) {
    return {
      data: { source: "runtime", result: runtime.value },
      message: `Transferred playback to ${selector}.`,
    };
  }
  const { player } = await cliSession();
  const target = uniqueDevice(await player.devices(), selector);
  if (target.id === null)
    throw unavailable(`Device ${target.name} has no transferable ID.`);
  await player.transfer(target.id, play);
  return {
    data: { device: target, play },
    message: `Transferred playback to ${target.name}.`,
  };
}
