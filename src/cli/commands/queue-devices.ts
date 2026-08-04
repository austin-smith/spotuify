import { Command } from "commander";
import type { CliIo } from "../output.ts";
import { deviceCurrent, deviceList, deviceTransfer } from "../operations/devices.ts";
import { queueAdd, queueList } from "../operations/queue.ts";
import { mutation, outputFor } from "../support.ts";

export function registerQueueAndDevices(program: Command, io: CliIo): void {
  const queue = program
    .command("queue")
    .description("Inspect and append to the Spotify queue");
  queue
    .command("list")
    .description("Show the current and upcoming items")
    .action(async (_options, command: Command) => {
      const result = await queueList();
      outputFor(command, io).emit("queue.list", result.data, result.message);
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
        const result = await queueAdd(items, { device: options.device });
        mutation(command, io, "queue.add", result.data, result.message);
      },
    );

  const device = program
    .command("device")
    .description("Inspect and transfer Spotify Connect devices");
  device
    .command("list")
    .description("List available devices")
    .action(async (_options, command: Command) => {
      const result = await deviceList();
      outputFor(command, io).emit("device.list", result.data, result.message);
    });
  device
    .command("current")
    .description("Show the active device")
    .action(async (_options, command: Command) => {
      const result = await deviceCurrent();
      outputFor(command, io).emit("device.current", result.data, result.message);
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
        const result = await deviceTransfer(selector, options.play);
        mutation(command, io, "device.transfer", result.data, result.message);
      },
    );
}
