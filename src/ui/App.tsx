import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { SpotifyClient } from "../api/client.ts";
import { PlayerApi } from "../api/player.ts";
import { isTrack, type Me } from "../api/types.ts";
import { tokenStore } from "../auth/flow.ts";
import { DEVICE_NAME, MissingClientIdError, REDIRECT_URI } from "../config.ts";
import { LibrespotEngine, type EngineStatus } from "../engine/librespot.ts";
import { useDevices } from "../store/devices.ts";
import { usePlayback } from "../store/playback.ts";
import { useQueue } from "../store/queue.ts";
import { useSearch } from "../store/search.ts";
import { CoverBackdrop } from "./CoverBackdrop.tsx";
import { DevicePicker } from "./DevicePicker.tsx";
import { QueueView } from "./QueueView.tsx";
import { Hud, HUD_ROWS } from "./Hud.tsx";
import { KeyHints } from "./KeyHints.tsx";
import { KeymapOverlay } from "./KeymapOverlay.tsx";
import { Palette, PROMPT_ROW } from "./Palette.tsx";
import { theme } from "./theme.ts";

type Boot =
  | { phase: "loading" }
  | { phase: "needs-setup"; message: string }
  | { phase: "ready"; me: Me; player: PlayerApi };

function Setup({ message }: { message: string }) {
  return (
    <box flexDirection="column" padding={2} gap={1}>
      <text fg={theme.accent}>
        <strong>SPOTUIFY</strong>
      </text>
      <text fg={theme.error}>{message}</text>
      <text fg={theme.label}>Redirect URI to register: {REDIRECT_URI}</text>
      <text fg={theme.label}>Then run: bun run src/cli.ts auth</text>
      <text fg={theme.label}>Q to quit.</text>
    </box>
  );
}

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [engine, setEngine] = useState<EngineStatus>({ state: "starting" });

  const item = usePlayback((s) => s.item);
  const isPlaying = usePlayback((s) => s.isPlaying);
  const progressMs = usePlayback((s) => s.progressMs);
  const durationMs = usePlayback((s) => s.durationMs);
  const shuffle = usePlayback((s) => s.shuffle);
  const repeat = usePlayback((s) => s.repeat);
  const volumePercent = usePlayback((s) => s.volumePercent);
  const deviceName = usePlayback((s) => s.deviceName);
  const ready = usePlayback((s) => s.ready);
  const error = usePlayback((s) => s.error);
  // Must sit with the other hooks: below the `boot.phase` early returns the hook count would
  // differ between the loading and ready renders, which React rejects outright.
  const paletteOpen = useSearch((s) => s.open);
  const devicesOpen = useDevices((s) => s.open);
  const queueOpen = useQueue((s) => s.open);
  const [keysOpen, setKeysOpen] = useState(false);
  const overlayOpen = paletteOpen || devicesOpen || queueOpen || keysOpen;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const client = new SpotifyClient(await tokenStore());
        const me = await client.get<Me>("/me");
        if (cancelled) return;
        const player = new PlayerApi(client);
        useSearch.getState().configure(client, me.country);
        useDevices.getState().configure(player);
        useQueue.getState().configure(player);
        setBoot({ phase: "ready", me, player });
      } catch (err) {
        if (cancelled) return;
        setBoot({
          phase: "needs-setup",
          message:
            err instanceof MissingClientIdError
              ? "No client ID configured. Set SPOTUIFY_CLIENT_ID."
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (boot.phase !== "ready") return;
    return usePlayback.getState().start(boot.player);
  }, [boot]);

  useEffect(() => {
    if (boot.phase !== "ready") return;

    const supervisor = new LibrespotEngine();
    const unsubscribe = supervisor.onStatus(setEngine);
    void supervisor.start();

    return () => {
      unsubscribe();
      supervisor.stop();
    };
  }, [boot]);

  // Once librespot registers, adopt it — unless another device is already active.
  useEffect(() => {
    if (boot.phase !== "ready" || engine.state !== "running") return;

    let cancelled = false;
    void (async () => {
      await Bun.sleep(1_500);
      if (cancelled) return;
      try {
        const devices = await boot.player.devices();
        const mine = devices.find((d) => d.name === DEVICE_NAME);
        const active = devices.find((d) => d.is_active);
        if (mine?.id != null && active === undefined) {
          await boot.player.transfer(mine.id, false);
          await usePlayback.getState().refresh();
        }
      } catch {
        // Not fatal: a device picker will make this explicit.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boot, engine.state]);

  useKeyboard((key) => {
    const palette = useSearch.getState();
    const picker = useDevices.getState();
    const queue = useQueue.getState();

    if (keysOpen) {
      if (key.name === "escape" || key.name === "?" || key.name === "q") setKeysOpen(false);
      return;
    }

    if (queue.open) {
      if (key.name === "escape" || key.name === "u") queue.closeQueue();
      else if (key.name === "r") void queue.refresh();
      return;
    }

    if (picker.open) {
      if (key.name === "escape") picker.closePicker();
      else if (key.name === "up" || (key.ctrl && key.name === "p")) picker.move(-1);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) picker.move(1);
      else if (key.name === "return") {
        void (async () => {
          await picker.activate();
          await usePlayback.getState().refresh();
        })();
      }
      return;
    }

    // While the palette is open the input consumes printable characters; only navigation,
    // confirmation and dismissal are handled here, and nothing falls through to transport keys.
    if (palette.open) {
      // Standard combobox keys: the field always holds the caret, arrows move the list highlight,
      // Enter accepts the highlighted row, escape closes. Left/Right stay text editing.
      if (key.name === "escape") {
        if (!palette.back()) palette.closePalette();
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        palette.move(-1);
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        palette.move(1);
      } else if (key.name === "return") {
        const row = palette.current();
        if (row === null || boot.phase !== "ready") return;

        // Ctrl+Enter appends instead of playing. Only single items can be queued — Spotify has no
        // way to append a whole album or artist.
        if (key.ctrl) {
          const uris = "uris" in row.play ? row.play.uris : [];
          const uri = uris[0];
          if (uri !== undefined) {
            void useQueue.getState().enqueue(uri, row.label);
            palette.closePalette();
          }
          return;
        }

        // Artists and albums open into their contents; anything else plays.
        if (row.drill !== undefined) {
          palette.drillInto(row.drill);
          return;
        }

        const deviceId = usePlayback.getState().deviceId;
        void (async () => {
          try {
            await boot.player.play({
              ...row.play,
              ...(deviceId !== null ? { deviceId } : {}),
            });
            await Bun.sleep(300);
            await usePlayback.getState().refresh();
          } catch (err) {
            // Actually surface it. Swallowing this meant a failed play looked like nothing
            // happening at all, with no way to find out why.
            usePlayback.setState({
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        palette.closePalette();
      }
      return;
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
      return;
    }
    if (boot.phase !== "ready") return;

    if (key.name === "/") {
      palette.openPalette();
      return;
    }

    if (key.name === "d") {
      picker.openPicker();
      return;
    }

    if (key.name === "u") {
      queue.openQueue();
      return;
    }

    if (key.name === "?") {
      setKeysOpen(true);
      return;
    }

    const store = usePlayback.getState();
    switch (key.name) {
      case "space":
        void store.togglePlay();
        break;
      case "n":
        void store.next();
        break;
      case "p":
        void store.previous();
        break;
      case "r":
        void store.refresh();
        break;
      case "s":
        void store.toggleShuffle();
        break;
      case "z":
        void store.cycleRepeat();
        break;
      case "right":
        void store.seekBy(5_000);
        break;
      case "left":
        void store.seekBy(-5_000);
        break;
      case "up":
        void store.adjustVolume(5);
        break;
      case "down":
        void store.adjustVolume(-5);
        break;
      default:
        break;
    }
  });

  if (boot.phase === "loading") {
    return (
      <box padding={2}>
        <text fg={theme.label}>Connecting to Spotify…</text>
      </box>
    );
  }
  if (boot.phase === "needs-setup") return <Setup message={boot.message} />;

  const images = item !== null && isTrack(item) ? item.album.images : null;

  // Row the HUD's darkened band starts at. The keybind strip draws over the cover on the final row,
  // so the scrim has to reach the very bottom.
  const hudTop = height - HUD_ROWS;

  return (
    <box flexGrow={1} position="relative">
      {images !== null && images.length > 0 ? (
        <CoverBackdrop
          images={images}
          width={width}
          // Full height in every state. Sizing this one row short to make room for the keybind
          // strip left an empty band whenever that strip was not drawn; the strip is an overlay and
          // sits on top of the cover instead.
          height={height}
          scrimFromRow={hudTop - 1}
          dim={overlayOpen}
          solidRow={paletteOpen ? PROMPT_ROW : null}
        />
      ) : null}

      {item !== null && !overlayOpen ? (
        <Hud
          item={item}
          progressMs={progressMs}
          durationMs={durationMs}
          isPlaying={isPlaying}
          shuffle={shuffle}
          repeat={repeat}
          volumePercent={volumePercent}
          deviceName={deviceName}
          width={width}
          height={height - 1}
        />
      ) : overlayOpen ? null : (
        <box position="absolute" left={2} top={Math.floor(height / 2)} zIndex={2}>
          <text fg={theme.muted}>
            {ready ? "NOTHING PLAYING — start a track on any device, then press R" : "LOADING…"}
          </text>
        </box>
      )}

      {error !== null ? (
        <box position="absolute" left={2} top={height - 2} zIndex={3}>
          <text fg={theme.error}>{error}</text>
        </box>
      ) : null}

      {overlayOpen ? null : (
        <box position="absolute" left={0} top={height - 1} width={width} zIndex={2}>
          <KeyHints width={width} playing={isPlaying} hasTrack={item !== null} />
        </box>
      )}

      {paletteOpen ? <Palette width={width} height={height} /> : null}
      {devicesOpen ? <DevicePicker width={width} height={height} /> : null}
      {queueOpen ? <QueueView width={width} height={height} /> : null}
      {keysOpen ? (
        <KeymapOverlay
          width={width}
          height={height}
          account={boot.me.display_name ?? boot.me.id}
          product={boot.me.product}
          engineUp={engine.state === "running"}
        />
      ) : null}
    </box>
  );
}
