mod playback_auth;

use anyhow::{Context, Result, anyhow};
use librespot_connect::{
    ConnectConfig, LoadContextOptions, LoadRequest, LoadRequestOptions, Options, PlayingTrack,
    Spirc,
};
use librespot_core::{Session, SpotifyUri, authentication::Credentials, config::SessionConfig};
use librespot_metadata::{Metadata, Track, audio::UniqueFields};
use librespot_playback::{
    audio_backend,
    config::{AudioFormat, Bitrate, PlayerConfig},
    mixer::{Mixer, MixerConfig, softmixer::SoftMixer},
    player::{Player, PlayerEvent},
};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{ffi::OsString, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
    task::JoinSet,
    time::timeout,
};

// Leave headroom for the parent process to receive and decode the error before its 10-second
// command deadline expires.
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(8);
const COMMAND_CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(8);
// The Bun parent keeps a longer forced-kill guard. This window is solely for Spirc to publish its
// final inactive state before the Session transport is torn down.
const GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartConfig {
    cache_dir: PathBuf,
    device_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    Activate {
        id: u64,
    },
    Transfer {
        id: u64,
    },
    Play {
        id: u64,
    },
    Pause {
        id: u64,
    },
    Next {
        id: u64,
    },
    Previous {
        id: u64,
    },
    Seek {
        id: u64,
        position_ms: u32,
    },
    Volume {
        id: u64,
        percent: u8,
    },
    Shuffle {
        id: u64,
        enabled: bool,
    },
    Repeat {
        id: u64,
        mode: RepeatMode,
    },
    ResolveTrack {
        id: u64,
        uri: String,
    },
    Load {
        id: u64,
        context_uri: Option<String>,
        uris: Option<Vec<String>>,
        offset: Option<u32>,
        shuffle: bool,
        repeat: RepeatMode,
    },
    Shutdown {
        id: u64,
    },
}

impl Command {
    fn id(&self) -> u64 {
        match self {
            Self::Activate { id }
            | Self::Transfer { id }
            | Self::Play { id }
            | Self::Pause { id }
            | Self::Next { id }
            | Self::Previous { id }
            | Self::Seek { id, .. }
            | Self::Volume { id, .. }
            | Self::Shuffle { id, .. }
            | Self::Repeat { id, .. }
            | Self::ResolveTrack { id, .. }
            | Self::Load { id, .. }
            | Self::Shutdown { id } => *id,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RepeatMode {
    Off,
    Context,
    Track,
}

fn repeat_flags(mode: RepeatMode) -> (bool, bool) {
    match mode {
        RepeatMode::Off => (false, false),
        RepeatMode::Context => (true, false),
        RepeatMode::Track => (true, true),
    }
}

fn load_options(shuffle: bool, repeat: RepeatMode) -> Options {
    let (repeat, repeat_track) = repeat_flags(repeat);
    Options {
        shuffle,
        repeat,
        repeat_track,
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Outgoing {
    Status {
        state: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<ResponseData>,
    },
    Event {
        event: PlayerEventMessage,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ResponseData {
    TrackMetadata { album: CatalogItem },
    PlayUnavailable { reason: &'static str },
}

#[derive(Debug, Serialize)]
struct CatalogItem {
    id: String,
    name: String,
    uri: String,
}

#[derive(Debug, Serialize)]
struct NativeArtist {
    id: String,
    name: String,
    uri: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "name", rename_all = "snake_case")]
enum PlayerEventMessage {
    TrackChanged {
        media_type: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        uri: String,
        title: String,
        duration_ms: u32,
        artists: Vec<NativeArtist>,
        album: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        show: Option<String>,
        covers: Vec<String>,
    },
    Playing {
        uri: String,
        position_ms: u32,
    },
    Paused {
        uri: String,
        position_ms: u32,
    },
    Stopped {
        uri: String,
    },
    EndOfTrack {
        uri: String,
    },
    Seeked {
        uri: String,
        position_ms: u32,
    },
    PositionChanged {
        uri: String,
        position_ms: u32,
    },
    VolumeChanged {
        percent: u8,
    },
    SessionConnected,
    SessionDisconnected,
    ShuffleChanged {
        enabled: bool,
    },
    RepeatChanged {
        context: bool,
        track: bool,
    },
}

#[tokio::main]
async fn main() {
    let invocation = match invocation_from_args(std::env::args_os().skip(1).collect()) {
        Ok(invocation) => invocation,
        Err(error) => {
            eprintln!("spotuify engine failed: {error:#}");
            std::process::exit(2);
        }
    };
    let result = match invocation {
        Invocation::Playback => run().await,
        Invocation::Authenticate => run_auth().await,
    };
    if let Err(error) = result {
        // This terminal message is intentionally credential free; neither cached credentials nor
        // OAuth tokens implement Display in spotuify's error path.
        eprintln!("spotuify engine failed: {error:#}");
        std::process::exit(1);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Invocation {
    Playback,
    Authenticate,
}

fn invocation_from_args(args: Vec<OsString>) -> Result<Invocation> {
    match args.as_slice() {
        [] => Ok(Invocation::Playback),
        [command] if command == "auth" => Ok(Invocation::Authenticate),
        _ => Err(anyhow!("usage: spotuify-engine [auth]")),
    }
}

async fn run_auth() -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let config_line = input
        .next_line()
        .await?
        .ok_or_else(|| anyhow!("missing authentication configuration"))?;
    let config: playback_auth::AuthConfig =
        serde_json::from_str(&config_line).context("invalid authentication configuration")?;
    let session_config = session_config_for_name(&config.device_name);
    playback_auth::authenticate(config, session_config).await
}

async fn run() -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let config_line = input
        .next_line()
        .await?
        .ok_or_else(|| anyhow!("missing startup configuration"))?;
    let config: StartConfig =
        serde_json::from_str(&config_line).context("invalid startup configuration")?;

    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<Outgoing>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outgoing_rx.recv().await {
            let mut encoded = serde_json::to_vec(&message).context("serializing engine message")?;
            encoded.push(b'\n');
            stdout
                .write_all(&encoded)
                .await
                .context("writing engine message")?;
            stdout.flush().await.context("flushing engine message")?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let runtime = match Runtime::connect(&config, outgoing_tx.clone()).await {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = outgoing_tx.send(Outgoing::Status {
                state: "failed",
                device_id: None,
                account_id: None,
                reason: Some(error.to_string()),
            });
            drop(outgoing_tx);
            writer.await.context("joining protocol writer")??;
            return Err(error);
        }
    };

    let account_id = runtime.session.username();
    if account_id.is_empty() {
        return Err(anyhow!(
            "Spotify Connect authenticated without a canonical account identity"
        ));
    }
    let _ = outgoing_tx.send(Outgoing::Status {
        state: "ready",
        device_id: Some(runtime.session.device_id().to_owned()),
        account_id: Some(account_id),
        reason: None,
    });

    // Metadata reads are independent of Spirc's ordered command stream. Track them so a slow
    // catalog lookup never holds up play/pause/seek, while still cancelling every lookup before
    // the Session is shut down.
    let mut metadata_tasks = JoinSet::new();
    while let Some(line) = input.next_line().await? {
        let command: Command = match serde_json::from_str(&line) {
            Ok(command) => command,
            Err(error) => {
                let _ = outgoing_tx.send(Outgoing::Status {
                    state: "protocol_error",
                    device_id: None,
                    account_id: None,
                    reason: Some(format!("invalid command: {error}")),
                });
                continue;
            }
        };

        if let Command::ResolveTrack { id, uri } = command {
            let session = runtime.session.clone();
            let outgoing = outgoing_tx.clone();
            metadata_tasks.spawn(async move {
                let response = response_for(id, resolve_track_metadata(&session, &uri).await);
                let _ = outgoing.send(response);
            });
            while metadata_tasks.try_join_next().is_some() {}
            continue;
        }

        let id = command.id();
        let shutdown = matches!(command, Command::Shutdown { .. });
        let response = response_for(id, runtime.apply(command).await);
        let _ = outgoing_tx.send(response);
        if shutdown {
            break;
        }
    }

    metadata_tasks.abort_all();
    while metadata_tasks.join_next().await.is_some() {}
    runtime.shutdown().await;
    drop(outgoing_tx);
    writer.await.context("joining protocol writer")??;
    Ok(())
}

fn response_for(id: u64, result: Result<Option<ResponseData>>) -> Outgoing {
    match result {
        Ok(data) => Outgoing::Response {
            id,
            ok: true,
            error: None,
            data,
        },
        Err(error) => Outgoing::Response {
            id,
            ok: false,
            error: Some(error.to_string()),
            data: None,
        },
    }
}

async fn resolve_track_metadata(session: &Session, uri: &str) -> Result<Option<ResponseData>> {
    let uri = SpotifyUri::from_uri(uri).context("parsing track URI")?;
    let SpotifyUri::Track { .. } = uri else {
        return Err(anyhow!("metadata resolution requires a catalog track"));
    };
    let track = Track::get(session, &uri)
        .await
        .context("resolving track metadata")?;
    Ok(Some(ResponseData::TrackMetadata {
        album: CatalogItem {
            id: track.album.id.to_id().context("encoding album id")?,
            name: track.album.name,
            uri: track.album.id.to_uri().context("encoding album URI")?,
        },
    }))
}

struct Runtime {
    session: Session,
    spirc: Spirc,
    active: watch::Receiver<bool>,
    playback: watch::Receiver<Observed<PlaybackState>>,
    position: watch::Receiver<Observed<u32>>,
    volume: watch::Receiver<Observed<u8>>,
    shuffle: watch::Receiver<Observed<bool>>,
    repeat: watch::Receiver<Observed<(bool, bool)>>,
    spirc_task: tokio::task::JoinHandle<()>,
    event_task: tokio::task::JoinHandle<()>,
    shutting_down: watch::Sender<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PlaybackPhase {
    Stopped,
    Transitioning,
    Playing,
    Paused,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PlaybackState {
    request_id: Option<u64>,
    phase: PlaybackPhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Observed<T> {
    revision: u64,
    value: T,
}

fn publish<T: Copy>(sender: &watch::Sender<Observed<T>>, value: T) {
    let revision = sender.borrow().revision.wrapping_add(1);
    sender.send_replace(Observed { revision, value });
}

impl Runtime {
    async fn connect(
        config: &StartConfig,
        outgoing: mpsc::UnboundedSender<Outgoing>,
    ) -> Result<Self> {
        let cache =
            playback_auth::open_cache(&config.cache_dir).context("opening librespot cache")?;
        let credentials: Credentials = cache.credentials().ok_or_else(|| {
            anyhow!("no cached librespot credentials; run `spotuify auth` outside the TUI")
        })?;
        let initial_volume = cache
            .volume()
            .unwrap_or_else(|| ConnectConfig::default().initial_volume);

        // Match librespot 0.8's standalone binary exactly so migrating to the sidecar preserves the
        // receiver identity already associated with this cache and device name.
        let session_config = session_config_for_name(&config.device_name);
        let session = Session::new(session_config, Some(cache));

        let mixer =
            Arc::new(SoftMixer::open(MixerConfig::default()).context("opening audio mixer")?);
        let backend =
            audio_backend::find(None).ok_or_else(|| anyhow!("no supported audio backend found"))?;
        let player = Player::new(
            PlayerConfig {
                bitrate: Bitrate::Bitrate320,
                position_update_interval: Some(Duration::from_secs(1)),
                ..PlayerConfig::default()
            },
            session.clone(),
            mixer.get_soft_volume(),
            move || backend(None, AudioFormat::default()),
        );

        mixer.set_volume(initial_volume);
        let connect_config = ConnectConfig {
            name: config.device_name.clone(),
            device_type: librespot_core::config::DeviceType::Computer,
            is_group: false,
            initial_volume,
            disable_volume: false,
            volume_steps: 64,
        };

        let (spirc, spirc_task) = Spirc::new(
            connect_config,
            session.clone(),
            credentials,
            player.clone(),
            mixer.clone(),
        )
        .await
        .context("connecting Spotify Connect session")?;

        // Subscribe before starting Spirc so an immediate activation event cannot be lost.
        let mut events = player.get_player_event_channel();
        let (active_tx, active) = watch::channel(false);
        // Each command observes the revision that existed before it was queued, then waits for a
        // matching player event. Spirc's methods only enqueue work, so returning before that event
        // would report success even when its asynchronous dispatch later fails.
        let (playback_tx, playback) = watch::channel(Observed {
            revision: 0,
            value: PlaybackState {
                request_id: None,
                phase: PlaybackPhase::Stopped,
            },
        });
        let (position_tx, position) = watch::channel(Observed {
            revision: 0,
            value: 0,
        });
        let (volume_tx, volume) = watch::channel(Observed {
            revision: 0,
            value: volume_percent(initial_volume),
        });
        let (shuffle_tx, shuffle) = watch::channel(Observed {
            revision: 0,
            value: false,
        });
        let (repeat_tx, repeat) = watch::channel(Observed {
            revision: 0,
            value: (false, false),
        });

        let (shutting_down, shutting_down_rx) = watch::channel(false);
        let spirc_outgoing = outgoing.clone();
        let spirc_task = tokio::spawn(async move {
            spirc_task.await;
            if !*shutting_down_rx.borrow() {
                let _ = spirc_outgoing.send(Outgoing::Status {
                    state: "failed",
                    device_id: None,
                    account_id: None,
                    reason: Some("Spotify Connect session ended".to_owned()),
                });
            }
        });

        let event_task = tokio::spawn(async move {
            let mut current_play_request_id = None;
            while let Some(event) = events.recv().await {
                match &event {
                    PlayerEvent::SessionConnected { .. } => {
                        active_tx.send_replace(true);
                    }
                    PlayerEvent::SessionDisconnected { .. } => {
                        active_tx.send_replace(false);
                        current_play_request_id = None;
                        publish(
                            &playback_tx,
                            PlaybackState {
                                request_id: None,
                                phase: PlaybackPhase::Stopped,
                            },
                        );
                    }
                    _ => {}
                }
                if let PlayerEvent::PlayRequestIdChanged { play_request_id } = &event {
                    current_play_request_id = Some(*play_request_id);
                    publish(
                        &playback_tx,
                        PlaybackState {
                            request_id: current_play_request_id,
                            phase: PlaybackPhase::Transitioning,
                        },
                    );
                    continue;
                }
                if let Some(play_request_id) = playback_event_request_id(&event)
                    && current_play_request_id != Some(play_request_id)
                {
                    // The player can deliver a late event from the previous track. Mirror Spirc's
                    // own request-id gate so stale playback cannot satisfy a command or reach the UI.
                    continue;
                }
                if let Some(phase) = observe_playback_phase(&event, &mut current_play_request_id) {
                    publish(
                        &playback_tx,
                        PlaybackState {
                            request_id: current_play_request_id,
                            phase,
                        },
                    );
                }
                match &event {
                    PlayerEvent::Seeked { position_ms, .. } => {
                        publish(&position_tx, *position_ms);
                    }
                    PlayerEvent::VolumeChanged { volume } => {
                        publish(&volume_tx, volume_percent(*volume));
                    }
                    PlayerEvent::ShuffleChanged { shuffle } => {
                        publish(&shuffle_tx, *shuffle);
                    }
                    PlayerEvent::RepeatChanged { context, track } => {
                        publish(&repeat_tx, (*context, *track));
                    }
                    _ => {}
                }
                if let Some(event) = map_player_event(event) {
                    let _ = outgoing.send(Outgoing::Event { event });
                }
            }
        });

        Ok(Self {
            session,
            spirc,
            active,
            playback,
            position,
            volume,
            shuffle,
            repeat,
            spirc_task,
            event_task,
            shutting_down,
        })
    }

    async fn apply(&self, command: Command) -> Result<Option<ResponseData>> {
        match command {
            Command::Activate { .. } => {
                if *self.active.borrow() {
                    return Ok(None);
                }
                self.spirc
                    .activate()
                    .context("activating the spotuify receiver")?;
                wait_for_activation(self.active.clone()).await?;
            }
            Command::Transfer { .. } => {
                if *self.active.borrow() {
                    return Ok(None);
                }
                self.spirc
                    .transfer(None)
                    .context("transferring playback to spotuify")?;
                wait_for_activation(self.active.clone()).await?;
            }
            Command::Play { .. } => {
                let before = *self.playback.borrow();
                if before.value.phase == PlaybackPhase::Stopped {
                    return Ok(Some(ResponseData::PlayUnavailable {
                        reason: "nothing is available to resume",
                    }));
                }
                self.spirc.play().context("resuming playback")?;
                if !wait_for_playing(self.playback.clone(), before.revision).await? {
                    return Ok(Some(ResponseData::PlayUnavailable {
                        reason: "nothing is available to resume",
                    }));
                }
            }
            Command::Pause { .. } => {
                let revision = self.playback.borrow().revision;
                self.spirc.pause().context("pausing playback")?;
                wait_for_observation(
                    self.playback.clone(),
                    revision,
                    |state| state.phase == PlaybackPhase::Paused,
                    "playback to pause",
                )
                .await?;
            }
            Command::Next { .. } => {
                let revision = self.playback.borrow().revision;
                self.spirc.next().context("skipping to next item")?;
                wait_for_transport(self.playback.clone(), revision, "next item").await?;
            }
            Command::Previous { .. } => {
                let playback_revision = self.playback.borrow().revision;
                let position_revision = self.position.borrow().revision;
                self.spirc.prev().context("skipping to previous item")?;
                wait_for_previous(
                    self.playback.clone(),
                    playback_revision,
                    self.position.clone(),
                    position_revision,
                )
                .await?;
            }
            Command::Seek { position_ms, .. } => {
                let revision = self.position.borrow().revision;
                self.spirc
                    .set_position_ms(position_ms)
                    .context("seeking playback")?;
                wait_for_observation(self.position.clone(), revision, |_| true, "seek to apply")
                    .await?;
            }
            Command::Volume { percent, .. } => {
                let percent = percent.min(100);
                let before = *self.volume.borrow();
                if before.value == percent {
                    return Ok(None);
                }
                let volume = (f64::from(percent) / 100.0 * f64::from(u16::MAX)).round() as u16;
                self.spirc.set_volume(volume).context("setting volume")?;
                wait_for_observation(
                    self.volume.clone(),
                    before.revision,
                    |observed| observed == percent,
                    "volume change to apply",
                )
                .await?;
            }
            Command::Shuffle { enabled, .. } => {
                let revision = self.shuffle.borrow().revision;
                self.spirc.shuffle(enabled).context("setting shuffle")?;
                wait_for_observation(
                    self.shuffle.clone(),
                    revision,
                    |observed| observed == enabled,
                    "shuffle change to apply",
                )
                .await?;
            }
            Command::Repeat { mode, .. } => {
                let revision = self.repeat.borrow().revision;
                let (context, track) = repeat_flags(mode);
                self.spirc
                    .repeat(context)
                    .context("setting context repeat")?;
                self.spirc
                    .repeat_track(track)
                    .context("setting track repeat")?;
                wait_for_observation(
                    self.repeat.clone(),
                    revision,
                    |observed| observed == (context, track),
                    "repeat change to apply",
                )
                .await?;
            }
            Command::ResolveTrack { .. } => {
                return Err(anyhow!("metadata command reached the ordered Spirc path"));
            }
            Command::Load {
                context_uri,
                uris,
                offset,
                shuffle,
                repeat,
                ..
            } => {
                let before = *self.playback.borrow();
                let options = LoadRequestOptions {
                    start_playing: true,
                    playing_track: offset.map(PlayingTrack::Index),
                    context_options: Some(LoadContextOptions::Options(load_options(
                        shuffle, repeat,
                    ))),
                    ..LoadRequestOptions::default()
                };
                let request = match (context_uri, uris) {
                    (Some(context), None) => LoadRequest::from_context_uri(context, options),
                    (None, Some(items)) if !items.is_empty() => {
                        LoadRequest::from_tracks(items, options)
                    }
                    _ => {
                        return Err(anyhow!(
                            "load requires exactly one non-empty playback source"
                        ));
                    }
                };
                self.spirc.load(request).context("loading playback")?;
                wait_for_load(self.playback.clone(), before).await?;
            }
            // `run` writes the acknowledgement before `Runtime::shutdown` sends the one shutdown
            // command. Sending it here as well creates a duplicate command and can race the reply.
            Command::Shutdown { .. } => {}
        }
        Ok(None)
    }

    async fn shutdown(mut self) {
        self.shutting_down.send_replace(true);
        let shutdown_queued = self.spirc.shutdown().is_ok();
        let spirc_finished = shutdown_queued
            && timeout(GRACEFUL_SHUTDOWN_TIMEOUT, &mut self.spirc_task)
                .await
                .is_ok();

        if !spirc_finished {
            self.spirc_task.abort();
            let _ = self.spirc_task.await;
        }

        // Spirc's shutdown command performs pause/disconnect and became_inactive through Session.
        // Keep Session alive until that work finishes or the bounded grace period expires.
        self.session.shutdown();
        self.event_task.abort();
        let _ = self.event_task.await;
    }
}

async fn wait_for_activation(mut active: watch::Receiver<bool>) -> Result<()> {
    timeout(ACTIVATION_TIMEOUT, async {
        loop {
            if *active.borrow_and_update() {
                return Ok(());
            }
            active
                .changed()
                .await
                .context("Spotify Connect activation channel closed")?;
        }
    })
    .await
    .context("timed out waiting for Spotify Connect activation")?
}

fn device_id_for_name(name: &str) -> String {
    format!("{:x}", Sha1::digest(name.as_bytes()))
}

fn session_config_for_name(name: &str) -> SessionConfig {
    SessionConfig {
        device_id: device_id_for_name(name),
        // Preserve the standalone receiver's explicit `--autoplay on` behavior. `None` follows the
        // account setting and therefore changes end-of-context behavior for existing users.
        autoplay: Some(true),
        ..SessionConfig::default()
    }
}

async fn wait_for_observation<T, F>(
    mut observed: watch::Receiver<Observed<T>>,
    after_revision: u64,
    mut matches: F,
    description: &'static str,
) -> Result<()>
where
    T: Copy,
    F: FnMut(T) -> bool,
{
    timeout(COMMAND_CONFIRMATION_TIMEOUT, async {
        loop {
            let current = *observed.borrow_and_update();
            if current.revision > after_revision && matches(current.value) {
                return Ok(());
            }
            observed
                .changed()
                .await
                .with_context(|| format!("{description} confirmation channel closed"))?;
        }
    })
    .await
    .with_context(|| format!("timed out waiting for {description}"))?
}

async fn wait_for_playing(
    mut playback: watch::Receiver<Observed<PlaybackState>>,
    after_revision: u64,
) -> Result<bool> {
    timeout(COMMAND_CONFIRMATION_TIMEOUT, async {
        loop {
            let current = *playback.borrow_and_update();
            if current.revision > after_revision {
                match current.value.phase {
                    PlaybackPhase::Playing => return Ok(true),
                    PlaybackPhase::Stopped => return Ok(false),
                    PlaybackPhase::Transitioning | PlaybackPhase::Paused => {}
                }
            }
            playback
                .changed()
                .await
                .context("playback confirmation channel closed")?;
        }
    })
    .await
    .context("timed out waiting for playback to resume")?
}

async fn wait_for_transport(
    playback: watch::Receiver<Observed<PlaybackState>>,
    after_revision: u64,
    description: &'static str,
) -> Result<()> {
    wait_for_observation(
        playback,
        after_revision,
        |state| state.phase != PlaybackPhase::Transitioning,
        description,
    )
    .await
}

async fn wait_for_previous(
    mut playback: watch::Receiver<Observed<PlaybackState>>,
    playback_revision: u64,
    mut position: watch::Receiver<Observed<u32>>,
    position_revision: u64,
) -> Result<()> {
    timeout(COMMAND_CONFIRMATION_TIMEOUT, async {
        loop {
            let playback_state = *playback.borrow_and_update();
            if playback_state.revision > playback_revision
                && playback_state.value.phase != PlaybackPhase::Transitioning
            {
                return Ok(());
            }
            if position.borrow_and_update().revision > position_revision {
                return Ok(());
            }

            tokio::select! {
                changed = playback.changed() => {
                    changed.context("previous-track playback confirmation channel closed")?;
                }
                changed = position.changed() => {
                    changed.context("previous-track position confirmation channel closed")?;
                }
            }
        }
    })
    .await
    .context("timed out waiting for previous-track command to apply")?
}

async fn wait_for_load(
    mut playback: watch::Receiver<Observed<PlaybackState>>,
    before: Observed<PlaybackState>,
) -> Result<()> {
    timeout(COMMAND_CONFIRMATION_TIMEOUT, async {
        loop {
            let current = *playback.borrow_and_update();
            if current.revision > before.revision
                && current.value.request_id != before.value.request_id
            {
                match current.value.phase {
                    PlaybackPhase::Playing => return Ok(()),
                    PlaybackPhase::Stopped => {
                        return Err(anyhow!("native load stopped before playback began"));
                    }
                    PlaybackPhase::Transitioning | PlaybackPhase::Paused => {}
                }
            }
            playback
                .changed()
                .await
                .context("load confirmation channel closed")?;
        }
    })
    .await
    .context("timed out waiting for native load to begin")?
}

fn observe_playback_phase(
    event: &PlayerEvent,
    current_play_request_id: &mut Option<u64>,
) -> Option<PlaybackPhase> {
    if let PlayerEvent::PlayRequestIdChanged { play_request_id } = event {
        *current_play_request_id = Some(*play_request_id);
        return None;
    }

    let (play_request_id, phase) = match event {
        PlayerEvent::Loading {
            play_request_id, ..
        }
        | PlayerEvent::EndOfTrack {
            play_request_id, ..
        } => (*play_request_id, PlaybackPhase::Transitioning),
        PlayerEvent::Playing {
            play_request_id, ..
        } => (*play_request_id, PlaybackPhase::Playing),
        PlayerEvent::Paused {
            play_request_id, ..
        } => (*play_request_id, PlaybackPhase::Paused),
        PlayerEvent::Stopped {
            play_request_id, ..
        } => (*play_request_id, PlaybackPhase::Stopped),
        _ => return None,
    };

    (*current_play_request_id == Some(play_request_id)).then_some(phase)
}

fn playback_event_request_id(event: &PlayerEvent) -> Option<u64> {
    event.get_play_request_id().or(match event {
        // librespot 0.8 omits this event from `get_play_request_id`, but it is equally scoped to one
        // load and must not correct the position of a newer track.
        PlayerEvent::PositionChanged {
            play_request_id, ..
        } => Some(*play_request_id),
        _ => None,
    })
}

fn volume_percent(volume: u16) -> u8 {
    ((f64::from(volume) / f64::from(u16::MAX)) * 100.0).round() as u8
}

fn map_player_event(event: PlayerEvent) -> Option<PlayerEventMessage> {
    match event {
        PlayerEvent::TrackChanged { audio_item } => {
            let id = audio_item.track_id.to_id().ok();
            let (media_type, artists, album, show) = match audio_item.unique_fields {
                UniqueFields::Track { artists, album, .. } => {
                    let artists = artists
                        .0
                        .into_iter()
                        .filter_map(|artist| {
                            Some(NativeArtist {
                                id: artist.id.to_id().ok()?,
                                name: artist.name,
                                uri: artist.id.to_uri().ok()?,
                            })
                        })
                        .collect();
                    ("track", artists, Some(album), None)
                }
                UniqueFields::Local { artists, album, .. } => {
                    let artists = artists
                        .unwrap_or_default()
                        .split('\n')
                        .filter(|name| !name.is_empty())
                        .map(|name| NativeArtist {
                            id: String::new(),
                            name: name.to_owned(),
                            uri: String::new(),
                        })
                        .collect();
                    ("local", artists, album, None)
                }
                UniqueFields::Episode { show_name, .. } => {
                    ("episode", Vec::new(), None, Some(show_name))
                }
            };
            Some(PlayerEventMessage::TrackChanged {
                media_type,
                id: if media_type == "local" { None } else { id },
                uri: audio_item.uri,
                title: audio_item.name,
                duration_ms: audio_item.duration_ms,
                artists,
                album,
                show,
                covers: audio_item
                    .covers
                    .into_iter()
                    .map(|cover| cover.url)
                    .collect(),
            })
        }
        PlayerEvent::Playing {
            track_id,
            position_ms,
            ..
        } => Some(PlayerEventMessage::Playing {
            uri: track_id.to_uri().ok()?,
            position_ms,
        }),
        PlayerEvent::Paused {
            track_id,
            position_ms,
            ..
        } => Some(PlayerEventMessage::Paused {
            uri: track_id.to_uri().ok()?,
            position_ms,
        }),
        PlayerEvent::Stopped { track_id, .. } => Some(PlayerEventMessage::Stopped {
            uri: track_id.to_uri().ok()?,
        }),
        PlayerEvent::EndOfTrack { track_id, .. } => Some(PlayerEventMessage::EndOfTrack {
            uri: track_id.to_uri().ok()?,
        }),
        PlayerEvent::Seeked {
            track_id,
            position_ms,
            ..
        }
        | PlayerEvent::PositionCorrection {
            track_id,
            position_ms,
            ..
        } => Some(PlayerEventMessage::Seeked {
            uri: track_id.to_uri().ok()?,
            position_ms,
        }),
        PlayerEvent::PositionChanged {
            track_id,
            position_ms,
            ..
        } => Some(PlayerEventMessage::PositionChanged {
            uri: track_id.to_uri().ok()?,
            position_ms,
        }),
        PlayerEvent::VolumeChanged { volume } => Some(PlayerEventMessage::VolumeChanged {
            percent: volume_percent(volume),
        }),
        PlayerEvent::SessionConnected { .. } => Some(PlayerEventMessage::SessionConnected),
        PlayerEvent::SessionDisconnected { .. } => Some(PlayerEventMessage::SessionDisconnected),
        PlayerEvent::ShuffleChanged { shuffle } => {
            Some(PlayerEventMessage::ShuffleChanged { enabled: shuffle })
        }
        PlayerEvent::RepeatChanged { context, track } => {
            Some(PlayerEventMessage::RepeatChanged { context, track })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_matches_librespot_cli_algorithm() {
        assert_eq!(
            device_id_for_name("spotuify"),
            "c77941ae06acef3ef6b17f577668e6100c0089ef"
        );
    }

    #[test]
    fn invocation_selects_only_the_documented_engine_modes() {
        assert_eq!(invocation_from_args(vec![]).unwrap(), Invocation::Playback);
        assert_eq!(
            invocation_from_args(vec![OsString::from("auth")]).unwrap(),
            Invocation::Authenticate
        );
        assert!(invocation_from_args(vec![OsString::from("unknown")]).is_err());
        assert!(
            invocation_from_args(vec![OsString::from("auth"), OsString::from("--force")]).is_err()
        );
    }

    #[test]
    fn session_config_preserves_the_standalone_autoplay_override() {
        assert_eq!(session_config_for_name("spotuify").autoplay, Some(true));
    }

    #[test]
    fn stale_player_events_do_not_change_the_observed_playback_phase() {
        let track_id =
            SpotifyUri::from_uri("spotify:track:4uLU6hMCjMI75M1A2tKUQC").expect("valid track URI");
        let event = PlayerEvent::Stopped {
            play_request_id: 7,
            track_id,
        };
        let mut current_play_request_id = Some(8);

        assert_eq!(
            playback_event_request_id(&event),
            Some(7),
            "the protocol gate must be able to identify the stale load"
        );
        assert_eq!(
            observe_playback_phase(&event, &mut current_play_request_id),
            None
        );
    }

    #[test]
    fn protocol_uses_the_expected_tag_names() {
        let ready = Outgoing::Status {
            state: "ready",
            device_id: Some("receiver".to_owned()),
            account_id: Some("account".to_owned()),
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(ready).unwrap(),
            serde_json::json!({
                "type": "status",
                "state": "ready",
                "device_id": "receiver",
                "account_id": "account"
            })
        );

        let event = Outgoing::Event {
            event: PlayerEventMessage::Playing {
                uri: "spotify:track:one".to_owned(),
                position_ms: 42,
            },
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "type": "event",
                "event": {
                    "name": "playing",
                    "uri": "spotify:track:one",
                    "position_ms": 42
                }
            })
        );
    }

    #[test]
    fn command_parser_rejects_unknown_operations() {
        let activate = r#"{"id":1,"command":"activate"}"#;
        assert!(matches!(
            serde_json::from_str::<Command>(activate),
            Ok(Command::Activate { id: 1 })
        ));

        let unknown = r#"{"id":1,"command":"surprise"}"#;
        assert!(serde_json::from_str::<Command>(unknown).is_err());
    }

    #[test]
    fn load_command_requires_and_preserves_playback_modes() {
        let load = r#"{
            "id": 7,
            "command": "load",
            "context_uri": "spotify:album:one",
            "shuffle": true,
            "repeat": "track"
        }"#;
        assert!(matches!(
            serde_json::from_str::<Command>(load),
            Ok(Command::Load {
                id: 7,
                shuffle: true,
                repeat: RepeatMode::Track,
                ..
            })
        ));

        let missing_modes = r#"{"id":7,"command":"load","context_uri":"spotify:album:one"}"#;
        assert!(serde_json::from_str::<Command>(missing_modes).is_err());
    }

    #[test]
    fn load_options_map_every_repeat_mode_without_changing_shuffle() {
        let off = load_options(true, RepeatMode::Off);
        assert!(off.shuffle);
        assert!(!off.repeat);
        assert!(!off.repeat_track);

        let context = load_options(false, RepeatMode::Context);
        assert!(!context.shuffle);
        assert!(context.repeat);
        assert!(!context.repeat_track);

        let track = load_options(true, RepeatMode::Track);
        assert!(track.shuffle);
        assert!(track.repeat);
        assert!(track.repeat_track);
    }

    #[tokio::test]
    async fn activation_wait_observes_a_later_connected_event() {
        let (active_tx, active_rx) = watch::channel(false);
        let waiter = tokio::spawn(wait_for_activation(active_rx));

        active_tx.send_replace(true);

        waiter.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn activation_wait_returns_when_already_active() {
        let (_active_tx, active_rx) = watch::channel(true);
        wait_for_activation(active_rx).await.unwrap();
    }

    #[tokio::test]
    async fn play_confirmation_reports_a_stopped_receiver_as_unavailable() {
        let (playback_tx, playback_rx) = watch::channel(Observed {
            revision: 0,
            value: PlaybackState {
                request_id: Some(1),
                phase: PlaybackPhase::Paused,
            },
        });
        let waiter = tokio::spawn(wait_for_playing(playback_rx, 0));

        publish(
            &playback_tx,
            PlaybackState {
                request_id: Some(1),
                phase: PlaybackPhase::Stopped,
            },
        );

        assert!(!waiter.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn play_confirmation_waits_for_the_playing_event() {
        let (playback_tx, playback_rx) = watch::channel(Observed {
            revision: 0,
            value: PlaybackState {
                request_id: Some(1),
                phase: PlaybackPhase::Paused,
            },
        });
        let waiter = tokio::spawn(wait_for_playing(playback_rx, 0));

        publish(
            &playback_tx,
            PlaybackState {
                request_id: Some(1),
                phase: PlaybackPhase::Playing,
            },
        );

        assert!(waiter.await.unwrap().unwrap());
    }

    #[tokio::test]
    async fn load_confirmation_requires_a_new_play_request() {
        let before = Observed {
            revision: 4,
            value: PlaybackState {
                request_id: Some(10),
                phase: PlaybackPhase::Playing,
            },
        };
        let (playback_tx, playback_rx) = watch::channel(before);
        let waiter = tokio::spawn(wait_for_load(playback_rx, before));

        publish(
            &playback_tx,
            PlaybackState {
                request_id: Some(10),
                phase: PlaybackPhase::Playing,
            },
        );
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        publish(
            &playback_tx,
            PlaybackState {
                request_id: Some(11),
                phase: PlaybackPhase::Playing,
            },
        );
        waiter.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn previous_confirmation_accepts_a_seek_to_the_start() {
        let (playback_tx, playback_rx) = watch::channel(Observed {
            revision: 2,
            value: PlaybackState {
                request_id: Some(10),
                phase: PlaybackPhase::Playing,
            },
        });
        let (position_tx, position_rx) = watch::channel(Observed {
            revision: 4,
            value: 8_000,
        });
        let waiter = tokio::spawn(wait_for_previous(playback_rx, 2, position_rx, 4));

        publish(&position_tx, 0);
        waiter.await.unwrap().unwrap();
        drop(playback_tx);
    }
}
