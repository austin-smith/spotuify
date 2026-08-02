import { Command } from "commander";
import { runtimeRequest, tryRuntimeRequest } from "../../runtime/control.ts";
import { unavailable, usageError } from "../errors.ts";
import {
  normalizeItem,
  normalizeRuntimePlayback,
  type CliIo,
} from "../output.ts";
import { cliSession } from "../session.ts";
import { spotifyReference } from "../values.ts";
import {
  allDevices,
  currentState,
  inactiveReceiver,
  itemRows,
  mutation,
  outputFor,
  resolveDeviceTarget,
  table,
  uniqueDevice,
} from "../support.ts";

/**
 * The item to report as playing now.
 *
 * The Web queue's `currently_playing` lags native events exactly like `/me/player`, so a connected
 * runtime's snapshot is authoritative for the current item — including when it says nothing is
 * playing. The upcoming list exists only in the Web response and stays with it.
 */
export function queueCurrentItem(
  runtime: { connected: true; value: unknown } | { connected: false },
  webCurrent: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!runtime.connected) return webCurrent;
  const item = normalizeRuntimePlayback(runtime.value)["item"];
  return item !== null && typeof item === "object"
    ? (item as Record<string, unknown>)
    : null;
}

export function registerQueueAndDevices(program: Command, io: CliIo): void {
  const queue = program
    .command("queue")
    .description("Inspect and append to the Spotify queue");
  queue
    .command("list")
    .description("Show the current and upcoming items")
    .action(async (_options, command: Command) => {
      const value = await (await cliSession()).player.queue();
      const runtime = await tryRuntimeRequest("status");
      const current = queueCurrentItem(
        runtime,
        normalizeItem(value.currently_playing),
      );
      const data = {
        current,
        items: value.queue.map(normalizeItem),
      };
      const currentLine =
        current === null
          ? "Nothing is playing."
          : `Now  ${String(current["name"] ?? "Unknown")} — ${String(current["artist"] ?? "")}`;
      const upcoming =
        value.queue.length === 0
          ? "Queue is empty."
          : table(
              ["#", "TITLE", "ARTIST", "TIME", "URI"],
              itemRows(value.queue),
            );
      outputFor(command, io).emit(
        "queue.list",
        data,
        `${currentLine}\n\n${upcoming}`,
      );
    });
  queue
    .command("add <items...>")
    .description("Append tracks or episodes to the queue")
    .option("-d, --device <id-or-name>", "target device")
    .action(
      async (
        items: string[],
        options: { device?: string },
        command: Command,
      ) => {
        const uris = items.map((item) => {
          const ref = spotifyReference(item);
          if (ref.kind !== "track" && ref.kind !== "episode")
            throw usageError(
              "Only tracks and episodes can be added to the queue.",
            );
          return ref.uri;
        });
        const resolved =
          options.device === undefined
            ? undefined
            : await resolveDeviceTarget(options.device);
        if (resolved?.route === "local" && !resolved.active) {
          inactiveReceiver(resolved.name);
        }
        // A running runtime owns the queue path: additions go through its client and serialize
        // with the other mutations instead of racing them from a second Web API session.
        if (resolved === undefined || resolved.route === "local") {
          const first = await tryRuntimeRequest("queue.add", { uri: uris[0] });
          if (first.connected) {
            for (const uri of uris.slice(1)) {
              await runtimeRequest("queue.add", { uri });
            }
            mutation(
              command,
              io,
              "queue.add",
              { source: "runtime", uris, deviceId: resolved?.id ?? null },
              `Added ${uris.length} item${uris.length === 1 ? "" : "s"} to the queue.`,
            );
            return;
          }
        }
        const { player } = await cliSession();
        const deviceId =
          resolved?.route === "web" ? resolved.device.id : undefined;
        for (const uri of uris) await player.addToQueue(uri, deviceId);
        mutation(
          command,
          io,
          "queue.add",
          { uris, deviceId: deviceId ?? null },
          `Added ${uris.length} item${uris.length === 1 ? "" : "s"} to the queue.`,
        );
      },
    );

  const device = program
    .command("device")
    .description("Inspect and transfer Spotify Connect devices");
  device
    .command("list")
    .description("List available devices")
    .action(async (_options, command: Command) => {
      // The runtime's merged view when available: it includes the embedded receiver, which
      // Spotify's device list does not always report. The listing must match what is targetable.
      const devices = await allDevices();
      outputFor(command, io).emit(
        "device.list",
        devices,
        table(
          ["ACTIVE", "NAME", "TYPE", "VOLUME", "ID"],
          devices.map((item) => [
            item.is_active ? "*" : "",
            item.name,
            item.type,
            item.volume_percent === null ? "—" : `${item.volume_percent}%`,
            item.id,
          ]),
        ),
      );
    });
  device
    .command("current")
    .description("Show the active device")
    .action(async (_options, command: Command) => {
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
        outputFor(command, io).emit(
          "device.current",
          device,
          `${device.name}${device.type === null ? "" : ` (${device.type})`}\n${device.id ?? "No device ID"}`,
        );
        return;
      }
      const state = await currentState();
      if (state?.device === null || state?.device === undefined)
        throw unavailable("No active playback device.");
      outputFor(command, io).emit(
        "device.current",
        state.device,
        `${state.device.name} (${state.device.type})\n${state.device.id ?? "No device ID"}`,
      );
    });
  device
    .command("transfer <id-or-name>")
    .description("Transfer playback to a device")
    .option("--no-play", "preserve paused state")
    .action(
      async (
        selector: string,
        options: { play: boolean },
        command: Command,
      ) => {
        const runtime = await tryRuntimeRequest("device.transfer", {
          selector,
          play: options.play,
        });
        if (runtime.connected) {
          mutation(
            command,
            io,
            "device.transfer",
            { source: "runtime", result: runtime.value },
            `Transferred playback to ${selector}.`,
          );
          return;
        }
        const { player } = await cliSession();
        const target = uniqueDevice(await player.devices(), selector);
        if (target.id === null)
          throw unavailable(`Device ${target.name} has no transferable ID.`);
        await player.transfer(target.id, options.play);
        mutation(
          command,
          io,
          "device.transfer",
          { device: target, play: options.play },
          `Transferred playback to ${target.name}.`,
        );
      },
    );
}
