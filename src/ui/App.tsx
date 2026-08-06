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
import { MissingClientIdError } from "../config.ts";
import { LibrespotEngine, type EngineStatus } from "../engine/librespot.ts";
import { useActions } from "../store/actions.ts";
import { useDevices } from "../store/devices.ts";
import { failureMessage } from "../store/error.ts";
import { useLyrics } from "../store/lyrics.ts";
import { useLibraryBrowser } from "../store/library-browser.ts";
import { usePlayback } from "../store/playback.ts";
import { playbackContextDrill } from "../store/playback-context.ts";
import { useQueue } from "../store/queue.ts";
import { useSearch } from "../store/search.ts";
import { startPlaybackControlServer } from "../runtime/playback-control.ts";
import {
  RuntimeAlreadyRunningError,
  type ControlServer,
} from "../runtime/control.ts";
import { spotifyOpenUrl } from "../spotify/reference.ts";
import {
  checkForUpdate,
  markUpdateNotified,
  type AvailableUpdate,
} from "../update.ts";
import { ActionsMenu } from "./ActionsMenu.tsx";
import { CoverBackdrop } from "./CoverBackdrop.tsx";
import { DevicePicker } from "./DevicePicker.tsx";
import { FeedbackBanner, feedbackTopAboveHud } from "./FeedbackBanner.tsx";
import { LyricsView } from "./LyricsView.tsx";
import { QueueView, queueListHeight } from "./QueueView.tsx";
import { SetupScreen } from "./SetupScreen.tsx";
import { StartupErrorScreen } from "./StartupErrorScreen.tsx";
import { HUD_LEFT, hudTopForHeight } from "./Hud.tsx";
import { KeyHints, KEY_HINT_ROWS } from "./KeyHints.tsx";
import { isPlainShortcut } from "./keys.ts";
import { KeymapOverlay } from "./KeymapOverlay.tsx";
import {
  LibraryView,
  LIBRARY_PROMPT_ROW,
  libraryListHeight,
} from "./LibraryView.tsx";
import { applyLibraryNavigation } from "./library-navigation.ts";
import { applyPaletteNavigation } from "./palette-navigation.ts";
import { OVERLAY_PADDING_X, overlayListHeight } from "./Overlay.tsx";
import { Palette, PROMPT_ROW } from "./Palette.tsx";
import { PlaylistPicker, PLAYLIST_PROMPT_ROW } from "./PlaylistPicker.tsx";
import {
  PlaybackEmptyState,
  STARTUP_MESSAGE_DELAY_MS,
} from "./PlaybackEmptyState.tsx";
import { PlaybackStage, playbackDisplayItem } from "./PlaybackStage.tsx";
import { theme } from "./theme.ts";

type Boot =
  | { phase: "loading" }
  | { phase: "needs-setup" }
  | { phase: "failed"; message: string }
  | {
      phase: "ready";
      me: Me | null;
      player: PlayerApi;
      client: SpotifyClient;
      authorizationId: string;
      profileRetryAt: number | null;
    };

type BootFailure = Extract<Boot, { phase: "needs-setup" | "failed" }>;

function isSetupFailure(error: unknown): boolean {
  return (
    error instanceof MissingClientIdError ||
    error instanceof ReauthRequiredError ||
    (error instanceof SpotifyApiError &&
      (error.status === 400 || error.status === 401 || error.status === 403))
  );
}

export function bootFailureFor(error: unknown): BootFailure {
  if (isSetupFailure(error)) {
    return { phase: "needs-setup" };
  }

  return {
    phase: "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function updateNoticeIsVisible(
  bootPhase: Boot["phase"],
  hasCompetingFeedback: boolean,
  overlayOpen: boolean,
): boolean {
  return (
    bootPhase === "needs-setup" ||
    (bootPhase === "ready" && !hasCompetingFeedback && !overlayOpen)
  );
}

export function App({ version }: { version: string }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });
  const [engine, setEngine] = useState<EngineStatus>({ state: "starting" });
  const [engineClient, setEngineClient] = useState<LibrespotEngine | null>(null);
  const [runtimeOwnership, setRuntimeOwnership] = useState<
    "waiting" | "checking" | "owned" | "unavailable" | "conflict"
  >("waiting");
  const [profileRecoveryRequest, setProfileRecoveryRequest] = useState(0);
  const [profileRecoveryFailed, setProfileRecoveryFailed] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [showUpdateNotice, setShowUpdateNotice] = useState(false);
  const [startupMessageVisible, setStartupMessageVisible] = useState(false);
  const profileRecoveryController = useRef<AbortController | null>(null);
  const playbackContextController = useRef<AbortController | null>(null);
  const activatedDevice = useRef<string | null>(null);
  const runtimeServer = useRef<ControlServer | null>(null);

  const item = usePlayback((s) => s.item);
  const pendingSelection = usePlayback((s) => s.pendingSelection);
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
  const libraryOpen = useLibraryBrowser((s) => s.open);
  const devicesOpen = useDevices((s) => s.open);
  const queueOpen = useQueue((s) => s.open);
  const actionsOpen = useActions((s) => s.open);
  const actionMode = useActions((s) => s.mode);
  const actionNotice = useActions((s) => s.notice);
  const lyricsOpen = useLyrics((s) => s.open);
  const [keysOpen, setKeysOpen] = useState(false);
  const overlayOpen =
    paletteOpen || libraryOpen || devicesOpen || queueOpen || actionsOpen || lyricsOpen || keysOpen;
  const bootPlayer = boot.phase === "ready" ? boot.player : null;
  const bootClient = boot.phase === "ready" ? boot.client : null;
  const bootAuthorizationId = boot.phase === "ready" ? boot.authorizationId : null;
  const bootProfile = boot.phase === "ready" ? boot.me : null;
  const bootAccountId = bootProfile?.id ?? null;
  const bootProfileRetryAt = boot.phase === "ready" ? boot.profileRetryAt : null;
  const canInitializePlayback =
    runtimeOwnership === "owned" || runtimeOwnership === "unavailable";
  const updateNoticeVisible = updateNoticeIsVisible(
    boot.phase,
    actionNotice !== null || error !== null,
    overlayOpen,
  );

  useEffect(() => {
    const controller = new AbortController();
    void checkForUpdate({ currentVersion: version, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.status !== "available") {
          setAvailableUpdate(null);
          setShowUpdateNotice(false);
          return;
        }
        setAvailableUpdate(result);
        setShowUpdateNotice(result.shouldNotify);
      })
      // A passive check must never destabilize the renderer, including if a future checker
      // implementation rejects instead of returning an unavailable result.
      .catch(() => {});
    return () => controller.abort();
  }, [version]);

  useEffect(() => {
    if (
      availableUpdate === null ||
      !showUpdateNotice ||
      !updateNoticeVisible
    ) {
      return;
    }
    // Effects run after paint, so a version is marked only after a screen capable of displaying
    // the notice has actually rendered. Quitting during boot must not consume the notification.
    void markUpdateNotified(availableUpdate);
  }, [availableUpdate, showUpdateNotice, updateNoticeVisible]);

  // One timer spans boot and the first playback poll, so a fast launch never flashes loading text.
  useEffect(() => {
    const timer = setTimeout(
      () => setStartupMessageVisible(true),
      STARTUP_MESSAGE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    let canceled = false;

    void (async () => {
      try {
        const tokens = await tokenStore();
        const authorizationId = await tokens.authorizationId();
        const client = new SpotifyClient(tokens);
        // A quota lockout is not an authentication/setup failure. A verified cached identity, or a
        // restricted profile-less mode, keeps the independent local receiver available.
        const profileResolution = await resolveBootProfile(client, authorizationId);
        const me = profileResolution.profile;
        if (canceled) return;
        const player = new PlayerApi(client);
        if (me !== null) {
          useSearch.getState().configure(client, me.country, me.id);
          useLibraryBrowser.getState().configure(client, me.country, me.id);
          useActions.getState().configure(client, me.id);
        }
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
      } catch (error) {
        if (canceled) return;
        setBoot(bootFailureFor(error));
      }
    })();

    return () => {
      canceled = true;
    };
  }, [bootAttempt]);

  useEffect(() => {
    if (bootPlayer === null) return;

    let canceled = false;
    let close: (() => Promise<void>) | undefined;
    setRuntimeOwnership("checking");
    void startPlaybackControlServer(bootPlayer, { publish: false })
      .then((server) => {
        if (canceled) {
          void server.close();
          return;
        }
        runtimeServer.current = server;
        close = () => server.close();
        setRuntimeOwnership("owned");
      })
      .catch((error) => {
        if (canceled) return;
        if (error instanceof RuntimeAlreadyRunningError) {
          setRuntimeOwnership("conflict");
          setEngine({ state: "failed", reason: error.message });
          return;
        }
        // Local automation is optional when the OS cannot expose a private endpoint. This is not
        // evidence of another playback owner, so the interactive app may still start normally.
        setRuntimeOwnership("unavailable");
      });

    return () => {
      canceled = true;
      setRuntimeOwnership("waiting");
      runtimeServer.current = null;
      void close?.();
    };
  }, [bootPlayer, runtimeAttempt]);

  useEffect(() => {
    if (
      bootPlayer === null ||
      !canInitializePlayback
    )
      return;

    const supervisor = new LibrespotEngine();
    let canceled = false;
    const unsubscribe = supervisor.onStatus(setEngine);
    void supervisor
      .start()
      .then(() => {
        if (!canceled) setEngineClient(supervisor);
      })
      .catch((err) => {
        // The supervisor owns normal launch failures. This is a final boundary for unexpected setup
        // errors so a rejected promise can never leave the UI stuck at "starting".
        if (canceled) return;
        setEngine({
          state: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        const server = runtimeServer.current;
        runtimeServer.current = null;
        void server?.close();
        setRuntimeOwnership("unavailable");
      });

    return () => {
      canceled = true;
      unsubscribe();
      supervisor.stop();
      setEngineClient(null);
    };
  }, [bootPlayer, canInitializePlayback]);

  useEffect(() => {
    if (bootPlayer === null || engineClient === null) return;
    useDevices.getState().configure(bootPlayer, engineClient, bootAccountId);
    let stopPlayback: (() => void) | undefined;
    if (bootAccountId === null) {
      // `/me` is the single recovery probe. Initialize command ownership with its Web
      // reconciliation lane suspended so `/me/player` cannot compete for the same Retry-After
      // deadline and the private runtime never serves an unconfigured default store.
      stopPlayback = usePlayback.getState().start(bootPlayer, engineClient, null, {
        suspendWebReconciliation: true,
      });
    } else {
      stopPlayback = usePlayback
        .getState()
        .start(bootPlayer, engineClient, bootAccountId, {
          // `/me` owns the finite Retry-After deadline. Keep librespot live, but do not let playback
          // schedule a competing `/me/player` probe until account recovery succeeds.
          suspendWebReconciliation: bootProfileRetryAt !== null,
        });
    }
    const server = runtimeServer.current;
    void server?.publish().catch(() => {
      if (runtimeServer.current !== server) return;
      runtimeServer.current = null;
      void server.close();
      setRuntimeOwnership("unavailable");
    });
    return () => stopPlayback?.();
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
        useLibraryBrowser.getState().configure(bootClient, profile.country, profile.id);
        useActions.getState().configure(bootClient, profile.id);
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
        if (isSetupFailure(err)) {
          setBoot((current) =>
            current.phase === "ready" &&
            current.client === bootClient &&
            current.authorizationId === bootAuthorizationId
              ? { phase: "needs-setup" }
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

  useEffect(() => () => playbackContextController.current?.abort(), []);

  useKeyboard((key) => {
    // A delayed context lookup must never interrupt a newer keyboard interaction. A fresh `c`
    // replaces the previous request; an auto-repeated `c` is ignored without canceling the one
    // deliberate invocation that started it.
    if (!(key.name === "c" && key.repeated)) {
      playbackContextController.current?.abort();
      playbackContextController.current = null;
    }

    const palette = useSearch.getState();
    const picker = useDevices.getState();
    const queue = useQueue.getState();
    const actions = useActions.getState();
    const lyrics = useLyrics.getState();
    const library = useLibraryBrowser.getState();

    const copySpotify = (uri: string, label: string, asLink: boolean) => {
      const value = asLink ? spotifyOpenUrl(uri) : uri;
      if (value === null || !renderer.isOsc52Supported()) {
        actions.notify({
          kind: "error",
          message: value === null ? "this item has no Spotify link" : "clipboard copy is unavailable",
        });
        return;
      }
      const copied = renderer.copyToClipboardOSC52(value);
      actions.notify({
        kind: copied ? "success" : "error",
        message: copied
          ? `copied ${label} ${asLink ? "link" : "URI"}`
          : "clipboard copy failed",
      });
    };

    if (keysOpen) {
      if (key.name === "escape" || key.name === "?" || key.name === "q") setKeysOpen(false);
      return;
    }

    if (lyrics.open) {
      // The list height the store has to clamp scrolling against; the overlay computes the same
      // number from the same helper.
      const viewport = overlayListHeight(height);
      if (key.name === "escape" || key.name === "l") lyrics.closeLyrics();
      // Option/Alt+arrow before the plain arrows, same as the palette: laptop Home/End.
      else if (key.option === true && key.name === "up") lyrics.scrollToEdge("top", viewport);
      else if (key.option === true && key.name === "down") lyrics.scrollToEdge("bottom", viewport);
      else if (key.name === "up" || (key.ctrl && key.name === "p")) lyrics.scrollBy(-1, viewport);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) lyrics.scrollBy(1, viewport);
      else if (key.name === "pageup") lyrics.scrollBy(-viewport, viewport);
      else if (key.name === "pagedown") lyrics.scrollBy(viewport, viewport);
      else if (key.name === "home") lyrics.scrollToEdge("top", viewport);
      else if (key.name === "end") lyrics.scrollToEdge("bottom", viewport);
      else if (key.name === "f") lyrics.setFollowing(true);
      else if (key.name === "r") lyrics.openLyrics(usePlayback.getState().item);
      return;
    }

    if (queue.open) {
      // The rows the queue view is actually showing, from the same helper it lays out with.
      const viewport = queueListHeight(height, queue);
      if (key.name === "escape" || key.name === "u") queue.closeQueue();
      else if (key.name === "r") void queue.refresh();
      // Option/Alt+arrow before the plain arrows, same as the palette: laptop Home/End.
      else if (key.option === true && key.name === "up") queue.scrollToEdge("top", viewport);
      else if (key.option === true && key.name === "down") queue.scrollToEdge("bottom", viewport);
      else if (key.name === "up" || (key.ctrl && key.name === "p")) queue.scrollBy(-1, viewport);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) queue.scrollBy(1, viewport);
      else if (key.name === "pageup") queue.scrollBy(-viewport, viewport);
      else if (key.name === "pagedown") queue.scrollBy(viewport, viewport);
      else if (key.name === "home") queue.scrollToEdge("top", viewport);
      else if (key.name === "end") queue.scrollToEdge("bottom", viewport);
      return;
    }

    if (actions.open) {
      if (key.name === "a" && key.repeated) return;
      // Spotify playlist and library writes are not safely cancelable. Keep the exact workflow
      // that initiated the mutation on screen until its result is bound back to that workflow.
      if (actions.busy) return;
      if (actions.mode === "playlists") {
        // The focused input owns printable characters; global handling is limited to list
        // navigation, confirmation and returning to the action list.
        if (key.name === "escape") actions.back();
        else if (key.name === "up" || (key.ctrl && key.name === "p")) actions.move(-1);
        else if (key.name === "down" || (key.ctrl && key.name === "n")) actions.move(1);
        else if (key.name === "return" || key.name === "enter") void actions.activate();
      } else if (key.name === "escape" || key.name === "a") {
        actions.closeActions();
      } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
        actions.move(-1);
      } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
        actions.move(1);
      } else if (key.name === "return" || key.name === "enter") {
        void actions.activate().then((result) => {
          if (result?.kind !== "drill") return;
          // Selected-item actions return to the surface that launched them. Playing-item actions
          // open a fresh search stack because they have no existing browse context.
          if (result.origin === "palette") palette.drillInto(result.drill);
          else if (result.origin === "library") library.drillInto(result.drill);
          else palette.openAt(result.drill);
        });
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

    // Library is one coherent filter-and-list mode. The input keeps printable characters while
    // Tab changes the root section and non-printing keys navigate the visible rows.
    if (library.open) {
      const isEnter = key.name === "return" || key.name === "enter";
      const viewport = libraryListHeight(height);
      const navigated = applyLibraryNavigation(key, library, {
        canChangeSection: library.depth() === 1,
        pageSize: viewport,
      });
      if (navigated) return;

      if (key.ctrl && key.name === "space") {
        const row = library.current();
        if (row?.actionItem !== undefined) actions.openActions(row.actionItem, "library");
      } else if (key.name === "escape") {
        if (!library.back()) library.closeLibrary();
      } else if (isEnter) {
        const row = library.current();
        if (row === null) {
          if (library.error() !== null) library.retry();
          return;
        }
        if (boot.phase !== "ready") return;

        if (key.ctrl) {
          const uris = "uris" in row.play ? row.play.uris : [];
          const uri = uris[0];
          if (uri !== undefined) {
            void useQueue.getState().enqueue(uri, row.label);
            library.closeLibrary();
          }
          return;
        }

        if (row.drill !== undefined) {
          library.drillInto(row.drill);
          return;
        }

        const preview = row.actionItem === undefined
          ? { label: row.label }
          : { label: row.label, item: row.actionItem };
        void usePlayback.getState().playSelection(row.play, preview);
        library.closeLibrary();
      }
      return;
    }

    // Search remains one coherent input mode: printable keys edit the query, arrows move the
    // selection, and Tab cycles the visible catalog scope directly. There is no hidden state in
    // which letters suddenly become navigation commands.
    if (palette.open) {
      const isEnter = key.name === "return" || key.name === "enter";
      const drilled = palette.depth() > 1;
      const viewport = overlayListHeight(height);
      const navigated = applyPaletteNavigation(
        key,
        palette,
        {
          canChangeScope: !drilled && !palette.showingReference,
          pageSize: viewport,
        },
      );
      if (navigated) return;

      if (key.ctrl && key.name === "space") {
        const row = palette.current();
        if (row?.actionItem !== undefined) actions.openActions(row.actionItem, "palette");
      } else if (key.name === "escape") {
        if (!palette.back()) palette.closePalette();
      } else if (isEnter) {
        const selectedRow = palette.currentRow();
        if (selectedRow?.kind === "more") {
          if (!selectedRow.loading) palette.loadMore(selectedRow.category);
          return;
        }
        const row = selectedRow?.kind === "result" ? selectedRow : null;
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

        const preview =
          row.actionItem === undefined
            ? { label: row.label }
            : { label: row.label, item: row.actionItem };
        void usePlayback.getState().playSelection(row.play, preview);
        palette.closePalette();
      }
      return;
    }

    if (key.name === "q") {
      renderer.destroy();
      return;
    }
    if (boot.phase === "failed" && key.name === "r") {
      setBoot({ phase: "loading" });
      setBootAttempt((attempt) => attempt + 1);
      return;
    }
    if (runtimeOwnership === "conflict" && key.name === "r") {
      setRuntimeOwnership("checking");
      setRuntimeAttempt((attempt) => attempt + 1);
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

    if (isPlainShortcut(key, "b")) {
      if (key.repeated || boot.me === null) return;
      library.openLibrary();
      return;
    }

    if (key.name === "d") {
      if (boot.me === null) return;
      picker.openPicker();
      return;
    }

    if (
      isPlainShortcut(key, "y", { allowShift: true }) &&
      !key.repeated &&
      item !== null
    ) {
      copySpotify(item.uri, item.name, key.shift);
      return;
    }

    if (key.name === "u") {
      queue.openQueue();
      return;
    }

    if (isPlainShortcut(key, "c")) {
      const profile = boot.me;
      if (key.repeated || profile === null) return;
      const controller = new AbortController();
      playbackContextController.current = controller;
      void (async () => {
        try {
          const currentPlayback = usePlayback.getState();
          const contextUri = currentPlayback.contextUri;
          const itemUri = currentPlayback.item?.uri ?? null;
          const target = await playbackContextDrill({
            client: boot.client,
            meId: profile.id,
            contextUri,
            item: currentPlayback.item,
            market: profile.country,
            signal: controller.signal,
          });
          const latestPlayback = usePlayback.getState();
          if (
            controller.signal.aborted ||
            playbackContextController.current !== controller ||
            latestPlayback.contextUri !== contextUri ||
            (latestPlayback.item?.uri ?? null) !== itemUri ||
            useSearch.getState().open
          ) {
            return;
          }
          palette.openAt(target);
        } catch (error) {
          if (
            controller.signal.aborted ||
            playbackContextController.current !== controller
          ) {
            return;
          }
          actions.notify({
            kind: "error",
            message: failureMessage("open current context", error),
          });
        } finally {
          if (playbackContextController.current === controller) {
            playbackContextController.current = null;
          }
        }
      })();
      return;
    }

    if (key.name === "a") {
      if (key.repeated) return;
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
        actions.openActions(playing, "playback");
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
          actions.openActions(resolved, "playback");
        }
      })();
      return;
    }

    if (key.name === "f") {
      if (key.repeated) return;
      if (boot.me === null) return;
      const playing = usePlayback.getState().item;
      if (playing !== null) void actions.toggleSaved(playing);
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
    // Same height PlaybackStage gets, so the wordmark doesn't jump when boot completes.
    return (
      <box width={width} height={height} position="relative">
        <PlaybackEmptyState
          ready={false}
          canSearch={false}
          startupMessageVisible={startupMessageVisible}
          width={width}
          height={Math.max(0, height - KEY_HINT_ROWS)}
        />
      </box>
    );
  }
  if (boot.phase === "needs-setup") {
    return (
      <SetupScreen
        updateAvailable={showUpdateNotice && availableUpdate !== null}
        width={width}
        height={height}
      />
    );
  }
  if (boot.phase === "failed") {
    return (
      <StartupErrorScreen
        message={boot.message}
        width={width}
        height={height}
      />
    );
  }
  // A bounded, explained conflict beats an unexplained startup splash: playback initialization is
  // deliberately blocked while another runtime owns local commands, and nothing else renders that.
  if (runtimeOwnership === "conflict") {
    return (
      <StartupErrorScreen
        message="Another Spotuify runtime is already serving local commands. Stop it with `spotuify service stop`, then retry."
        width={width}
        height={height}
      />
    );
  }

  // Keep real playback authoritative. A preview fills only the genuinely empty gap between search
  // dismissal and the first confirmed native/Web state.
  const displayItem = playbackDisplayItem(item, pendingSelection);
  const images = displayItem !== null && isTrack(displayItem) ? displayItem.album.images : null;

  // Row the HUD's darkened band starts at. The keybind strip draws over the cover on the final row,
  // so the scrim has to reach the very bottom.
  const contentHeight = Math.max(0, height - KEY_HINT_ROWS);
  const hudTop = hudTopForHeight(contentHeight);
  const feedbackTop = feedbackTopAboveHud(hudTop);
  const feedback =
    actionNotice ??
    (error !== null
      ? { kind: "error" as const, message: error }
      : showUpdateNotice && availableUpdate !== null
        ? {
            kind: "info" as const,
            message: `spotuify v${availableUpdate.latestVersion} is available — run: spotuify update`,
          }
        : null);

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
          scrimFromRow={feedbackTop}
          dim={overlayOpen}
          solidRow={
            paletteOpen && !actionsOpen
              ? PROMPT_ROW
              : libraryOpen && !actionsOpen
                ? LIBRARY_PROMPT_ROW
              : actionsOpen && actionMode === "playlists"
                ? PLAYLIST_PROMPT_ROW
                : null
          }
        />
      ) : null}

      <PlaybackStage
        item={item}
        pendingSelection={pendingSelection}
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
        ready={ready}
        canSearch={boot.me !== null}
        startupMessageVisible={startupMessageVisible}
        overlayOpen={overlayOpen}
        width={width}
        height={contentHeight}
      />

      {feedback !== null &&
      !actionsOpen &&
      // Existing playback faults stay behind overlays; action confirmations must remain visible
      // when a selected-item action returns to the palette that launched it.
      (actionNotice !== null || !overlayOpen) ? (
        <FeedbackBanner
          message={feedback.message}
          kind={feedback.kind}
          width={width}
          // One clear row above the HUD; inside the bottom padding while another overlay is open.
          top={overlayOpen ? Math.max(0, height - 2) : feedbackTop}
          textLeft={overlayOpen ? OVERLAY_PADDING_X : HUD_LEFT}
        />
      ) : null}

      {overlayOpen ? null : (
        <box position="absolute" left={0} top={contentHeight} width={width} zIndex={2}>
          <KeyHints
            width={width}
            playing={isPlaying}
            hasTrack={item !== null}
            canBrowse={boot.me !== null}
          />
        </box>
      )}

      {paletteOpen && !actionsOpen ? <Palette width={width} height={height} /> : null}
      {libraryOpen && !actionsOpen ? <LibraryView width={width} height={height} /> : null}
      {devicesOpen ? <DevicePicker width={width} height={height} /> : null}
      {queueOpen ? <QueueView width={width} height={height} /> : null}
      {actionsOpen && actionMode === "actions" ? (
        <ActionsMenu width={width} height={height} />
      ) : null}
      {actionsOpen && actionMode === "playlists" ? (
        <PlaylistPicker width={width} height={height} />
      ) : null}
      {lyricsOpen ? <LyricsView width={width} height={height} item={item} /> : null}
      {keysOpen ? (
        <KeymapOverlay
          width={width}
          height={height}
          version={version}
          account={boot.me === null ? "web api quota exhausted" : (boot.me.display_name ?? boot.me.id)}
          engine={engine}
          webAccountId={bootAccountId}
          canBrowse={boot.me !== null}
          updateVersion={availableUpdate?.latestVersion ?? null}
        />
      ) : null}
    </box>
  );
}
