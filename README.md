# spotuify

spotify in ur terminal 

<p align="center">
  <img src="./docs/screenshots/now-playing.png" alt="Now playing" width="90%" />
</p>

## Setup

> **Warning**
>
> spotuify streams audio through [librespot](https://github.com/librespot-org/librespot) and
> requires Spotify Premium. Install librespot before use:
>
> - macOS: `brew install librespot`
> - Most everything else: `cargo install librespot`

### 1. Register a Spotify app

Create one at <https://developer.spotify.com/dashboard> and add exactly this redirect URI — it must
match byte-for-byte, including the trailing path:

```
http://127.0.0.1:8989/callback
```

### 2. Point spotuify at your app

```bash
export SPOTUIFY_CLIENT_ID=<your client id>
```

Or write it to `~/.config/spotuify/config.json`:

```bash
echo '{"clientId":"<your client id>"}' > ~/.config/spotuify/config.json
```

### 3. Authorize

Opens a browser, so run it outside the TUI:

```bash
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
