import { Command } from "commander";
import { artistLine } from "../../api/types.ts";
import { tryRuntimeRequest } from "../../runtime/control.ts";
import { unavailable, usageError } from "../errors.ts";
import { normalizeItem, type CliIo } from "../output.ts";
import { cliSession } from "../session.ts";
import { spotifyReference } from "../values.ts";
import {
  allDevices,
  currentState,
  itemRows,
  mutation,
  outputFor,
  selectedDevice,
  table,
  uniqueDevice,
} from "../support.ts";

export function registerQueueAndDevices(program: Command, io: CliIo): void {
  const queue = program
    .command("queue")
    .description("Inspect and append to the Spotify queue");
  queue
    .command("list")
    .description("Show the current and upcoming items")
    .action(async (_options, command: Command) => {
      const value = await (await cliSession()).player.queue();
      const data = {
        current: normalizeItem(value.currently_playing),
        items: value.queue.map(normalizeItem),
      };
      const current =
        value.currently_playing === null
          ? "Nothing is playing."
          : `Now  ${value.currently_playing.name} — ${artistLine(value.currently_playing)}`;
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
        `${current}\n\n${upcoming}`,
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
        const { player } = await cliSession();
        const deviceId =
          options.device === undefined
            ? undefined
            : (await selectedDevice(options.device)).id;
        const uris = items.map((item) => {
          const ref = spotifyReference(item);
          if (ref.kind !== "track" && ref.kind !== "episode")
            throw usageError(
              "Only tracks and episodes can be added to the queue.",
            );
          return ref.uri;
        });
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
