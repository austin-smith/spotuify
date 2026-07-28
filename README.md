# spotuify

A Spotify client for the terminal, built on [OpenTUI](https://opentui.com).

Streams audio itself via a [librespot](https://github.com/librespot-org/librespot) sidecar, so it is
a real player rather than only a Spotify Connect remote. Requires **Spotify Premium**.

<p align="center">
  <img src="./docs/screenshots/now-playing.png" alt="Now playing" width="90%" />
</p>

## Setup

**1. Install librespot** (the audio engine):

```sh
brew install librespot        # or: cargo install librespot
```

**2. Register a Spotify app** at <https://developer.spotify.com/dashboard>, and add exactly this
redirect URI — it must match byte-for-byte, including the trailing path:

```
http://127.0.0.1:8989/callback
```

**3. Point spotuify at your app:**

```sh
export SPOTUIFY_CLIENT_ID=<your client id>
# or: echo '{"clientId":"<your client id>"}' > ~/.config/spotuify/config.json
```

**4. Authorize** (opens a browser; run this outside the TUI):

```sh
bun run src/cli.ts auth
```

The token pair is cached at `~/.config/spotuify/token.json` with mode `0600` and refreshed
automatically. Spotify expires refresh tokens roughly six months after authorization; when that
happens, `spotuify auth` re-runs the interactive flow.

## Development

```sh
bun test           # unit tests
bun run typecheck  # tsc --noEmit
bun run dev        # TUI with hot reload
```

## Architecture

Auth is deliberately split in two:

- **librespot** runs its own OAuth flow (`--enable-oauth`) for the audio session and caches
  credentials under `~/.cache/spotuify/librespot`.
- **spotuify** uses Authorization Code + PKCE against *your* registered app for every Web API call.

The Web API access token is never passed to librespot — Spotify's login5 does not reliably accept a
third-party app's token.

Playback state is polled every 5 s and `progress_ms` is extrapolated locally between polls, which
keeps a smooth progress bar at ~12 requests/minute.
