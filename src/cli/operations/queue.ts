import { runtimeRequest, tryRuntimeRequest } from "../../runtime/control.ts";
import { usageError } from "../errors.ts";
import { normalizeItem, normalizeRuntimePlayback } from "../output.ts";
import { cliSession } from "../session.ts";
import { activeDeviceTarget, itemRows, table } from "../support.ts";
import { spotifyReference } from "../values.ts";
import type { OperationResult } from "./types.ts";

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

export async function queueList(): Promise<
  OperationResult<Record<string, unknown>>
> {
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
      : table(["#", "TITLE", "ARTIST", "TIME", "URI"], itemRows(value.queue));
  return { data, message: `${currentLine}\n\n${upcoming}` };
}

export async function queueAdd(
  items: string[],
  options: { device?: string } = {},
): Promise<OperationResult<Record<string, unknown>>> {
  if (items.length === 0) {
    throw usageError("At least one track or episode is required.");
  }
  const uris = items.map((item) => {
    const ref = spotifyReference(item);
    if (ref.kind !== "track" && ref.kind !== "episode")
      throw usageError("Only tracks and episodes can be added to the queue.");
    return ref.uri;
  });
  const resolved = await activeDeviceTarget(options.device);
  const message = `Added ${uris.length} item${uris.length === 1 ? "" : "s"} to the queue.`;
  // A running runtime owns the queue path: additions go through its client and serialize
  // with the other mutations instead of racing them from a second Web API session.
  if (resolved === undefined || resolved.route === "local") {
    const first = await tryRuntimeRequest("queue.add", { uri: uris[0] });
    if (first.connected) {
      for (const uri of uris.slice(1)) {
        await runtimeRequest("queue.add", { uri });
      }
      return {
        data: { source: "runtime", uris, deviceId: resolved?.id ?? null },
        message,
      };
    }
  }
  const { player } = await cliSession();
  const deviceId = resolved?.route === "web" ? resolved.device.id : undefined;
  for (const uri of uris) await player.addToQueue(uri, deviceId);
  return { data: { uris, deviceId: deviceId ?? null }, message };
}
