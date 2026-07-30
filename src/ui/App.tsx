import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { SpotifyApiError, SpotifyClient, SpotifyLimitError } from "../api/client.ts";
import { PlayerApi } from "../api/player.ts";
import { isTrack, type Me } from "../api/types.ts";
import { tokenStore } from "../auth/flow.ts";
import {
  bootProfileRecoveryMode,
  recoverBootProfile,
  resolveBootProfile,
  retryBootProfile,
  shouldRetryBootProfile,
} from "../auth/profile.ts";
import { ReauthRequiredError } from "../auth/tokens.ts";
import { MissingClientIdError, REDIRECT_URI } from "../config.ts";
import { LibrespotEngine, type EngineStatus } from "../engine/librespot.ts";
import { useActions } from "../store/actions.ts";
import { useDevices } from "../store/devices.ts";
import { useLyrics } from "../store/lyrics.ts";
import { usePlayback } from "../store/playback.ts";
import { useQueue } from "../store/queue.ts";
import { useSearch } from "../store/search.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { CoverBackdrop } from "./CoverBackdrop.tsx";
import { DevicePicker } from "./DevicePicker.tsx";
import { LyricsView } from "./LyricsView.tsx";
import { QueueView } from "./QueueView.tsx";
import { Hud, HUD_ROWS } from "./Hud.tsx";
import { KeyHints } from "./KeyHints.tsx";
import { KeymapOverlay } from "./KeymapOverlay.tsx";
import { overlayListHeight } from "./Overlay.tsx";
import { Palette, PROMPT_ROW } from "./Palette.tsx";
import { PlaybackEmptyState } from "./PlaybackEmptyState.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

type Boot =
  | { phase: "loading" }
  | { phase: "needs-setup"; message: string }
  | {
      phase: "ready";
      me: Me | null;
      player: PlayerApi;
      client: SpotifyClient;
      authorizationId: string;
      profileRetryAt: number | null;
    };

function Setup({ message }: { message: string }) {
  return (
    <box flexDirection="column" padding={2} gap={1}>
      <text fg={theme.accent}>
        <strong>SPOTUIFY</strong>
      </text>
      <text fg={theme.error}>{message}</text>
      <text fg={theme.label}>Redirect URI to register: {REDIRECT_URI}</text>
      <text fg={theme.label}>Then run: bun run auth</text>
      <text fg={theme.label}>Q to quit.</text>
    </box>
  );
}

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [engine, setEngine] = useState<EngineStatus>({ state: "starting" });
  const [engineClient, setEngineClient] = useState<LibrespotEngine | null>(null);
  const [profileRecoveryRequest, setProfileRecoveryRequest] = useState(0);
  const [profileRecoveryFailed, setProfileRecoveryFailed] = useState(false);
  const profileRecoveryController = useRef<AbortController | null>(null);
  const activatedDevice = useRef<string | null>(null);

  const item = usePlayback((s) => s.item);
  const isPlaying = usePlayback((s) => s.isPlaying);
  const progressMs = usePlayback((s) => s.progressMs);
  const durationMs = usePlayback((s) => s.durationMs);
  const shuffle = usePlayback((s) => s.shuffle);
  const repeat = usePlayback((s) => s.repeat);
  const volumePercent = usePlayback((s) => s.volumePercent);
  const deviceId = usePlayback((s) => s.deviceId);
  const deviceName = usePlayback((s) => s.deviceName);
  const sessionPresence = usePlayback((s) => s.sessionPresence);
  const ready = usePlayback((s) => s.ready);
  const error = usePlayback((s) => s.error);
  // Must sit with the other hooks: below the `boot.phase` early returns the hook count would
  // differ between the loading and ready renders, which React rejects outright.
  const paletteOpen = useSearch((s) => s.open);
  const devicesOpen = useDevices((s) => s.open);
  const queueOpen = useQueue((s) => s.open);
  const actionsOpen = useActions((s) => s.open);
  const lyricsOpen = useLyrics((s) => s.open);
  const [keysOpen, setKeysOpen] = useState(false);
  const overlayOpen =
    paletteOpen || devicesOpen || queueOpen || actionsOpen || lyricsOpen || keysOpen;
  const bootPlayer = boot.phase === "ready" ? boot.player : null;
  const bootClient = boot.phase === "ready" ? boot.client : null;
  const bootAuthorizationId = boot.phase === "ready" ? boot.authorizationId : null;
  const bootProfile = boot.phase === "ready" ? boot.me : null;
  const bootAccountId = bootProfile?.id ?? null;
  const bootProfileRetryAt = boot.phase === "ready" ? boot.profileRetryAt : null;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const tokens = await tokenStore();
        const authorizationId = await tokens.authorizationId();
        const client = new SpotifyClient(tokens);
        // A quota lockout is not an authentication/setup failure. A verified cached identity, or a
        // restricted profile-less mode, keeps the independent local receiver available.
        const profileResolution = await resolveBootProfile(client, authorizationId);
        const me = profileResolution.profile;
        if (cancelled) return;
        const player = new PlayerApi(client);
        if (me !== null) useSearch.getState().configure(client, me.country, me.id);
        useDevices.getState().configure(player, undefined, me?.id ?? null);
        useQueue.getState().configure(player);
        setBoot({
          phase: "ready",
          me,
          player,
          client,
          authorizationId,
          profileRetryAt: profileResolution.retryAt,
        });
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
    if (bootPlayer === null) return;

    const supervisor = new LibrespotEngine();
    let cancelled = false;
    const unsubscribe = supervisor.onStatus(setEngine);
    setEngineClient(supervisor);
    void supervisor.start().catch((err) => {
      // The supervisor owns normal launch failures. This is a final boundary for unexpected setup
      // errors so a rejected promise can never leave the UI stuck at "starting".
      if (!cancelled) {
        setEngine({
          state: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      supervisor.stop();
      setEngineClient(null);
    };
  }, [bootPlayer]);

  useEffect(() => {
    if (bootPlayer === null || engineClient === null) return;
    useDevices.getState().configure(bootPlayer, engineClient, bootAccountId);
    if (bootAccountId === null) {
      // `/me` is the single recovery probe. Starting playback here would schedule `/me/player` at
      // the same Retry-After deadline and make the two lanes compete for scarce quota.
      usePlayback.setState({
        item: null,
        isPlaying: false,
        shuffle: false,
        repeat: "off",
        volumePercent: null,
        deviceId: null,
        deviceName: null,
        sessionPresence: "unknown",
        progressMs: 0,
        durationMs: 0,
        error: null,
        ready: true,
      });
      return;
    }
    return usePlayback.getState().start(bootPlayer, engineClient, bootAccountId, {
      // `/me` owns the finite Retry-After deadline. Keep librespot live, but do not let playback
      // schedule a competing `/me/player` probe until account recovery succeeds.
      suspendWebReconciliation: bootProfileRetryAt !== null,
    });
    // Profile recovery resumes the existing store explicitly. Restarting it when only the retry
    // deadline clears would discard authoritative native state because listeners do not replay it.
  }, [bootPlayer, engineClient, bootAccountId]);

  useEffect(() => {
    const recoveryMode = bootProfileRecoveryMode(
      bootProfileRetryAt,
      profileRecoveryRequest,
    );
    if (
      bootClient === null ||
      bootAuthorizationId === null ||
      recoveryMode === null
    ) {
      return;
    }

    const controller = new AbortController();
    profileRecoveryController.current = controller;
    const recoveredCachedProfile = bootProfile !== null;
    // Manual recovery can begin after normal polling has started. Stop that lane before `/me`
    // probes the shared client so playback cannot consume the next advertised retry deadline.
    if (recoveredCachedProfile) {
      usePlayback.getState().suspendWebReconciliation();
    }
    const recovery =
      recoveryMode === "manual"
        ? retryBootProfile(bootClient, bootAuthorizationId, controller.signal)
        : recoverBootProfile(
            bootClient,
            bootAuthorizationId,
            controller.signal,
            bootProfileRetryAt,
          );
    void recovery
      .then((profile) => {
        if (controller.signal.aborted || profile === null) return;
        setProfileRecoveryFailed(false);
        setProfileRecoveryRequest(0);
        useSearch.getState().configure(bootClient, profile.country, profile.id);
        usePlayback.setState({ error: null });
        setBoot((current) =>
          current.phase === "ready" &&
          current.client === bootClient &&
          current.authorizationId === bootAuthorizationId
            ? { ...current, me: profile, profileRetryAt: null }
            : current,
        );
        // A cached profile already started the playback store with only its Web lane suspended.
        // Resume it once after `/me` succeeds. A profile-less boot starts the store when `boot.me`
        // changes and must not issue a duplicate playback read here.
        if (recoveredCachedProfile) {
          void usePlayback.getState().resumeWebReconciliation();
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const message =
          err instanceof SpotifyLimitError
            ? "Spotify is still limiting account verification"
            : err instanceof Error
              ? err.message
              : String(err);
        if (
          err instanceof ReauthRequiredError ||
          (err instanceof SpotifyApiError &&
            (err.status === 400 || err.status === 401 || err.status === 403))
        ) {
          setBoot((current) =>
            current.phase === "ready" &&
            current.client === bootClient &&
            current.authorizationId === bootAuthorizationId
              ? { phase: "needs-setup", message }
              : current,
          );
        } else {
          setProfileRecoveryFailed(true);
          usePlayback.setState({
            error: `${message} — press r to retry account verification`,
          });
        }
      })
      .finally(() => {
        if (profileRecoveryController.current === controller) {
          profileRecoveryController.current = null;
        }
      });
    return () => controller.abort();
  }, [
    bootClient,
    bootAuthorizationId,
    bootProfile,
    bootProfileRetryAt,
    profileRecoveryRequest,
  ]);

  // Auto-adopt only when a successful 204 proved there is no playback session. A returned playback
  // object may have a null item or device id and still belong to another active receiver.
  useEffect(() => {
    if (
      engine.state !== "ready" ||
      bootAccountId === null ||
      engine.accountId !== bootAccountId
    ) {
      activatedDevice.current = null;
      return;
    }
    if (
      engineClient === null ||
      !ready ||
      sessionPresence !== "absent" ||
      error !== null ||
      activatedDevice.current === engine.deviceId
    ) {
      return;
    }
    activatedDevice.current = engine.deviceId;
    void engineClient.activate().catch((err) => {
      activatedDevice.current = null;
      usePlayback.setState({ error: err instanceof Error ? err.message : String(err) });
    });
  }, [engine, engineClient, bootAccountId, ready, sessionPresence, error]);

  // Lyrics follow the music: leaving the overlay open through a track change loads the new song
  // rather than leaving the previous one's words on screen. Keyed on the track, not the object —
  // every poll produces a fresh one.
  const trackKey = item === null ? null : (item.id ?? item.uri);
  useEffect(() => {
    useLyrics.getState().follow(item);
  }, [trackKey]);

  useKeyboard((key) => {
    const palette = useSearch.getState();
    const picker = useDevices.getState();
    const queue = useQueue.getState();
    const actions = useActions.getState();
    const lyrics = useLyrics.getState();

    if (keysOpen) {
      if (key.name === "escape" || key.name === "?" || key.name === "q") setKeysOpen(false);
      return;
    }

    if (lyrics.open) {
      // The list height the store has to clamp scrolling against; the overlay computes the same
      // number from the same helper.
      const viewport = overlayListHeight(height);
      if (key.name === "escape" || key.name === "l") lyrics.closeLyrics();
      else if (key.name === "up" || (key.ctrl && key.name === "p")) lyrics.scrollBy(-1, viewport);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) lyrics.scrollBy(1, viewport);
      else if (key.name === "pageup") lyrics.scrollBy(-viewport, viewport);
      else if (key.name === "pagedown") lyrics.scrollBy(viewport, viewport);
      else if (key.name === "home") lyrics.scrollTo(0);
      else if (key.name === "r") lyrics.openLyrics(usePlayback.getState().item);
      return;
    }

    if (queue.open) {
      if (key.name === "escape" || key.name === "u") queue.closeQueue();
      else if (key.name === "r") void queue.refresh();
      return;
    }

    if (actions.open) {
      if (key.name === "escape" || key.name === "a") actions.closeActions();
      else if (key.name === "up" || (key.ctrl && key.name === "p")) actions.move(-1);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) actions.move(1);
      else if (key.name === "return") {
        const entry = actions.current();
        actions.closeActions();
        // Hands off to the palette, so the album or artist lands in the same list you would have
        // reached by searching for it — and escape walks back out the same way.
        if (entry !== null) palette.openAt(entry.drill);
      }
      return;
    }

    if (picker.open) {
      if (key.name === "escape") picker.closePicker();
      else if (key.name === "up" || (key.ctrl && key.name === "p")) picker.move(-1);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) picker.move(1);
      else if (key.name === "return") {
        void picker.activate();
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

        void (async () => {
          await usePlayback.getState().playSelection(row.play);
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
      // Without a verified profile, ownership-sensitive library/search setup is intentionally
      // unavailable. Native and device control also stay disabled until both logins can be bound
      // to the same Spotify account.
      if (boot.me === null) return;
      palette.openPalette();
      return;
    }

    if (key.name === "d") {
      if (boot.me === null) return;
      picker.openPicker();
      return;
    }

    if (key.name === "u") {
      queue.openQueue();
      return;
    }

    if (key.name === "a") {
      // Album and artist actions drill through the Web API-backed palette, which is deliberately
      // unconfigured during profile-less quota mode.
      if (boot.me === null) return;
      const playback = usePlayback.getState();
      const playing = playback.item;
      if (playing === null) return;

      const nativeStatus = engineClient?.getStatus();
      const needsAlbum =
        isTrack(playing) &&
        playing.is_local !== true &&
        playing.album.id === "" &&
        nativeStatus?.state === "ready" &&
        bootAccountId !== null &&
        nativeStatus.accountId === bootAccountId &&
        playback.deviceId === nativeStatus.deviceId;
      if (!needsAlbum || engineClient === null || !isTrack(playing)) {
        actions.openActions(playing);
        return;
      }

      // AudioItem already carries artist ids, but librespot omits the album id from its player
      // event. Resolve that one missing relationship only when the user asks for actions.
      void (async () => {
        let resolved = playing;
        try {
          const metadata = await engineClient.resolveTrack(playing.uri);
          resolved = {
            ...playing,
            album: {
              ...playing.album,
              ...metadata.album,
            },
          };
        } catch {
          // Artist actions remain useful when optional album enrichment is unavailable.
        }
        if (usePlayback.getState().item?.uri === playing.uri) {
          actions.openActions(resolved);
        }
      })();
      return;
    }

    if (key.name === "l") {
      lyrics.openLyrics(usePlayback.getState().item);
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
        if (shouldRetryBootProfile(boot.me, profileRecoveryFailed, boot.client.getCooldown())) {
          if (profileRecoveryController.current === null) {
            if (boot.me !== null) store.suspendWebReconciliation();
            setProfileRecoveryFailed(false);
            usePlayback.setState({ error: null });
            setProfileRecoveryRequest((request) => request + 1);
          }
        } else {
          void store.refresh("foreground");
        }
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
          isLocalDevice={
            engine.state === "ready" &&
            bootAccountId !== null &&
            engine.accountId === bootAccountId &&
            deviceId === engine.deviceId
          }
          width={width}
          height={height - 1}
        />
      ) : overlayOpen ? null : (
        <PlaybackEmptyState
          ready={ready}
          canSearch={boot.me !== null}
          height={height}
        />
      )}

      {error !== null && !overlayOpen ? (
        // Above the HUD, not on it: at `height - 2` this landed on the state row and drew over
        // "PLAYING · VOL 100%".
        <box position="absolute" left={2} top={hudTop - 1} zIndex={3}>
          <text fg={theme.error}>{truncate(error, Math.max(0, width - 4))}</text>
        </box>
      ) : null}

      {overlayOpen ? null : (
        <box position="absolute" left={0} top={height - 1} width={width} zIndex={2}>
          <KeyHints
            width={width}
            playing={isPlaying}
            hasTrack={item !== null}
            canBrowse={boot.me !== null}
          />
        </box>
      )}

      {paletteOpen ? <Palette width={width} height={height} /> : null}
      {devicesOpen ? <DevicePicker width={width} height={height} /> : null}
      {queueOpen ? <QueueView width={width} height={height} /> : null}
      {actionsOpen && item !== null ? (
        <ActionsMenu width={width} height={height} item={item} />
      ) : null}
      {lyricsOpen ? <LyricsView width={width} height={height} item={item} /> : null}
      {keysOpen ? (
        <KeymapOverlay
          width={width}
          height={height}
          account={boot.me === null ? "web api quota exhausted" : (boot.me.display_name ?? boot.me.id)}
          product={boot.me?.product}
          engine={engine}
          webAccountId={bootAccountId}
          canBrowse={boot.me !== null}
        />
      ) : null}
    </box>
  );
}
