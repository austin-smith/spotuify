# Spotuify CLI

Spotuify's command-line interface supports one-shot playback control, Spotify browsing, library and
playlist management, and shell automation.

## Quick start

Authorize both independent Spotify sessions once:

```sh
spotuify auth
```

Then inspect and control playback:

```sh
spotuify status
spotuify play
spotuify pause
spotuify seek +30s
spotuify volume 50
spotuify device list
```

Every command has local help:

```sh
spotuify --help
spotuify playlist --help
spotuify playlist move --help
```

## Playback

`play` accepts Spotify URIs, open.spotify.com URLs, and an optional one-based context position:

```sh
spotuify play spotify:track:4iV5W9uYEdYUVa79Axb7Rh
spotuify play https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy --index 3
spotuify open spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
spotuify next
spotuify previous
spotuify shuffle toggle
spotuify repeat context
```

Times accept seconds, `mm:ss`, `hh:mm:ss`, or compact durations. A leading sign makes a seek
relative:

```sh
spotuify seek 1:30
spotuify seek -15s
spotuify seek +2m30s
```

Volume accepts an absolute percentage or a signed adjustment:

```sh
spotuify volume 75
spotuify volume -5
```

Every playback command except `status` and `toggle` accepts `--device <id-or-name>` when a
specific Spotify Connect device should receive the operation — `play`, `pause`, `open`,
`next`, `previous`, `seek`, `volume`, `shuffle`, `repeat`, and `queue add`. Device IDs are
unambiguous; a name is accepted only when exactly one device has that name. When a local runtime
is running, selectors resolve against its device view, which includes the embedded `spotuify`
receiver even when Spotify's own device list omits it — and `device list` shows the same view.

A selector naming the embedded receiver routes through its runtime rather than the Web API:
`play` and `open` transfer playback there natively before starting, while the state commands
(`pause`, `next`, `previous`, `seek`, `volume`, `shuffle`, `repeat`) require the receiver to
already be the active device — the same commands aimed at any other idle device would fail at
Spotify anyway. All other devices are reached through the Web API.

## Browse and manage Spotify

The CLI covers discovery, listening history, the library, followed artists, queue, devices, and
owned playlists:

```sh
spotuify search "kind of blue" --type album
spotuify search "song exploder" --type show --limit 20
spotuify show spotify:album:1weenld61qoidwYuZ1GESA
spotuify lyrics
spotuify history recent --limit 10 --after 2026-07-01T00:00:00Z
spotuify history top --range long
spotuify history top --type artist

spotuify library save spotify:album:4aawyAB9vmqN3uQ7FjRGTy
spotuify library remove spotify:album:4aawyAB9vmqN3uQ7FjRGTy

spotuify follow list
spotuify follow add spotify:artist:0OdUWJ0sBjDrqHygGUXeCF

spotuify queue list
spotuify queue add spotify:track:4iV5W9uYEdYUVa79Axb7Rh
spotuify device transfer "Living Room"
```

`search --type all` covers tracks, artists, albums, and playlists; ask for `show`, `episode`, or
`audiobook` by name. `--limit` applies per type, and the CLI pages through Spotify's 10-per-request
search window as needed. `show` on a podcast lists the latest fifty episodes — the way to find an
episode URI to play or queue. `history recent` walks further back with `--before`/`--after` and
`history top` with `--offset`.

Playlist commands use Spotify's current playlist-items API. Spotify exposes contents only for
playlists the signed-in user owns or collaborates on. Playlists hold tracks and episodes, and both
appear in `playlist show`.

```sh
spotuify playlist list --owned
spotuify playlist show spotify:playlist:PLAYLIST_ID
spotuify playlist create "Road trip" --description "Summer drive"
spotuify playlist add spotify:playlist:PLAYLIST_ID spotify:track:TRACK_ID
spotuify playlist remove spotify:playlist:PLAYLIST_ID spotify:track:TRACK_ID
spotuify playlist replace spotify:playlist:PLAYLIST_ID spotify:track:FIRST spotify:track:SECOND
spotuify playlist replace spotify:playlist:PLAYLIST_ID  # clear it
spotuify playlist edit spotify:playlist:PLAYLIST_ID --visibility private
spotuify playlist move spotify:playlist:PLAYLIST_ID --from 8 --before 2 --length 3
spotuify playlist follow spotify:playlist:PLAYLIST_ID
spotuify playlist unfollow spotify:playlist:PLAYLIST_ID
spotuify playlist delete spotify:playlist:PLAYLIST_ID
```

Playlist move positions are one-based. `--snapshot <id>` is available on remove and move when a
script needs optimistic concurrency against a known Spotify playlist snapshot.

Spotify has no separate delete operation — an owned playlist that everyone unfollows stops
existing. `playlist delete` therefore verifies ownership first and refuses playlists that belong
to someone else; `playlist unfollow` is the command for removing another person's playlist from
the library.

## Automation output

The default is readable terminal output. Pipes receive stable undecorated text. For automation,
choose an explicit format:

```sh
spotuify status --json
spotuify queue list --output json
spotuify status --field item.uri
spotuify status --template '{item.name} — {item.artist}'
spotuify pause --quiet
```

An absent `--field` value prints an empty line. This keeps successful mutations successful when an
optional response field is not present.

JSON and JSON Lines use a versioned envelope and snake-case field names:

```json
{
  "schema_version": 1,
  "command": "status",
  "data": { "active": true, "is_playing": true }
}
```

Errors go to stderr. In JSON modes they use a separate versioned error envelope. Successful data
is never mixed with diagnostics on stdout. `NO_COLOR`, `TERM=dumb`, and CI environments disable
decorated interactive presentation.

Generate static shell completion with:

```sh
spotuify completion bash
spotuify completion zsh
spotuify completion fish
```

## Runtime behavior

When the TUI is open, playback commands automatically use its private local runtime. This keeps
native playback events authoritative and avoids a second process racing the TUI through Spotify's
Web API. If no runtime is present, one-shot commands use the Web API directly and never start a
renderer, playback engine, service, or browser.

`status --watch` requires a running local runtime and samples only local state; it does not increase
Spotify polling. JSON Lines are convenient for a long-running consumer:

```sh
spotuify status --watch --output jsonl
```

A renderer-free runtime can be supervised in the foreground:

```sh
spotuify service run
spotuify service status
spotuify service stop
```

`service run` deliberately does not daemonize itself. Use the operating system's service manager
when restart policy, boot startup, and log retention are required.

## Authentication and diagnostics

Only `spotuify auth` may prompt or open a browser. Every other command is non-interactive and exits
with an actionable error when setup is missing or credentials need renewal.

```sh
spotuify account show
spotuify config show
spotuify config path
spotuify doctor
spotuify logout
```

`logout` removes the stored Web API token, the cached profile, and the playback engine's
credentials and cache. The configured Client ID stays — signing out does not unconfigure the
application. A Spotuify session that is already running keeps its authorization until it exits.

Web API authorization and terminal playback authorization remain independent. The Web API token is
never passed to the native playback engine.

Spotify reference links:

- [Player API](https://developer.spotify.com/documentation/web-api/reference/#category-player)
- [Get playlist items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items)
- [Update playlist items](https://developer.spotify.com/documentation/web-api/reference/reorder-or-replace-playlists-items)
- [Library API](https://developer.spotify.com/documentation/web-api/reference/save-library-items)

## Exit status

| Code | Meaning                                                         |
| ---: | --------------------------------------------------------------- |
|    0 | Success, including a valid empty result                         |
|    1 | Operational failure or failed doctor check                      |
|    2 | Invalid command or option                                       |
|    3 | Authentication or setup required                                |
|    4 | Requested runtime, device, playback, or resource unavailable    |
|    5 | Permission, Premium, or unsupported operation                   |
|    6 | Temporary network, Spotify rate-limit, quota, or server failure |
|   10 | `update --check` found an available update                      |
|  130 | Interrupted watch or interactive authorization                  |
