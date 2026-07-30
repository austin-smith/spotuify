import type { SpotifyClient } from "./client.ts";
import type { Device, PlayableItem, PlaybackState, RepeatState } from "./types.ts";

/**
 * Spotify Connect playback control.
 *
 * Every mutating call optionally targets a `deviceId`; without one Spotify applies it to the
 * account's active device, which fails with 404 when nothing is active.
 */
export class PlayerApi {
  constructor(private readonly client: SpotifyClient) {}

  /** Current playback, or `null` when Spotify reports no active session (204). */
  async state(
    priority: "foreground" | "background" = "background",
    signal?: AbortSignal,
  ): Promise<PlaybackState | null> {
    return await this.client.request<PlaybackState>("/me/player", {
      query: { additional_types: "track,episode" },
      priority,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * What is playing and what comes next.
   *
   * `queue` is Spotify's own up-next list, which mixes explicitly queued items with whatever the
   * current context will play; it is read-only and cannot be reordered through the API.
   */
  async queue(
    signal?: AbortSignal,
  ): Promise<{ currently_playing: PlayableItem | null; queue: PlayableItem[] }> {
    const res = await this.client.request<{
      currently_playing: PlayableItem | null;
      queue: (PlayableItem | null)[] | null;
    }>("/me/player/queue", signal ? { signal } : {});

    return {
      currently_playing: res?.currently_playing ?? null,
      queue: (res?.queue ?? []).filter((i): i is PlayableItem => i !== null && i !== undefined),
    };
  }

  /** Append a track or episode to the up-next list. Requires an active device. */
  async addToQueue(uri: string, deviceId?: string): Promise<void> {
    await this.client.request("/me/player/queue", {
      method: "POST",
      query: { uri, device_id: deviceId },
    });
  }

  async devices(signal?: AbortSignal): Promise<Device[]> {
    const res = await this.client.request<{ devices: Device[] }>("/me/player/devices", {
      ...(signal ? { signal } : {}),
    });
    return res?.devices ?? [];
  }

  async play(options: { deviceId?: string; contextUri?: string; uris?: string[]; offset?: number } = {}): Promise<void> {
    const body: Record<string, unknown> = {};
    if (options.contextUri !== undefined) body["context_uri"] = options.contextUri;
    if (options.uris !== undefined) body["uris"] = options.uris;
    if (options.offset !== undefined) body["offset"] = { position: options.offset };

    await this.client.request("/me/player/play", {
      method: "PUT",
      query: { device_id: options.deviceId },
      ...(Object.keys(body).length > 0 ? { body } : {}),
    });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.client.request("/me/player/pause", { method: "PUT", query: { device_id: deviceId } });
  }

  async next(deviceId?: string): Promise<void> {
    await this.client.request("/me/player/next", { method: "POST", query: { device_id: deviceId } });
  }

  async previous(deviceId?: string): Promise<void> {
    await this.client.request("/me/player/previous", {
      method: "POST",
      query: { device_id: deviceId },
    });
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    await this.client.request("/me/player/seek", {
      method: "PUT",
      query: { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId },
    });
  }

  async setVolume(percent: number, deviceId?: string): Promise<void> {
    await this.client.request("/me/player/volume", {
      method: "PUT",
      query: { volume_percent: Math.min(100, Math.max(0, Math.round(percent))), device_id: deviceId },
    });
  }

  async setShuffle(on: boolean, deviceId?: string): Promise<void> {
    await this.client.request("/me/player/shuffle", {
      method: "PUT",
      query: { state: on, device_id: deviceId },
    });
  }

  async setRepeat(mode: RepeatState, deviceId?: string): Promise<void> {
    await this.client.request("/me/player/repeat", {
      method: "PUT",
      query: { state: mode, device_id: deviceId },
    });
  }

  /** Move playback to a device. `play: true` resumes there; otherwise the paused state carries over. */
  async transfer(deviceId: string, play = true): Promise<void> {
    await this.client.request("/me/player", {
      method: "PUT",
      body: { device_ids: [deviceId], play },
    });
  }
}

/** The next repeat mode in the order the Spotify clients cycle through. */
export function nextRepeatState(current: RepeatState): RepeatState {
  switch (current) {
    case "off":
      return "context";
    case "context":
      return "track";
    case "track":
      return "off";
  }
}
