<h1 align="center">spotuify</h1>

<p align="center">🕺 spotify in ur terminal</p>

<p align="center">
  <a href="https://bun.sh"><img alt="Bun 1.3" src="https://img.shields.io/badge/Bun%201.3-000000?logo=bun&logoColor=white"></a>
  <a href="https://www.rust-lang.org"><img alt="Rust" src="https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white"></a>
  <a href="https://opentui.com"><img alt="OpenTUI 0.4" src="https://img.shields.io/badge/OpenTUI%200.4-6E56CF"></a>
  <a href="https://github.com/librespot-org/librespot"><img alt="librespot 0.8" src="https://img.shields.io/badge/librespot%200.8-000000?logo=rust&logoColor=white"></a>
</p>

<p align="center">
  <img src="./docs/screenshots/now-playing.png" alt="Now playing" width="90%" />
</p>

## Install

### npm (macOS, Linux, Windows)

```sh
npm install -g spotuify          # stable
npm install -g spotuify@canary   # canary
```

### Homebrew (macOS)

```sh
brew install austin-smith/tap/spotuify
```

### Direct download

macOS, Linux, and Windows builds are available from
[GitHub Releases](https://github.com/austin-smith/spotuify/releases).

## Setup

Playback requires [Spotify Premium](https://www.spotify.com/us/premium/).

### 1. Register a Spotify app

Create one at <https://developer.spotify.com/dashboard> and add this redirect URI:

```
http://127.0.0.1:8989/callback
```

### 2. Point spotuify at your app

```bash
export SPOTUIFY_CLIENT_ID=<your client id>
```

On Windows PowerShell:

```powershell
$env:SPOTUIFY_CLIENT_ID = "<your client id>"
```

On macOS or Linux, you can instead write it to `~/.config/spotuify/config.json`:

```bash
mkdir -p ~/.config/spotuify
echo '{"clientId":"<your client id>"}' > ~/.config/spotuify/config.json
```

### 3. Authorize

```bash
spotuify auth
```

The Web API token pair is cached at `~/.config/spotuify/token.json` and refreshed automatically.
Spotify refresh tokens expire six months after authorization; when that happens, re-run
`spotuify auth` to complete the interactive flow again.

This authorizes both the Spotify Web API and terminal playback. Re-run it with `--force` to replace
the Web API login or `--force-engine` to replace only the playback login.

## Development

Running from source requires [Bun](https://bun.sh) and [Rust](https://rustup.rs/).

On Linux, install the native build dependencies:

- Debian/Ubuntu: `sudo apt install build-essential pkg-config libasound2-dev`
- Arch: `sudo pacman -S --needed base-devel alsa-lib`

```sh
bun install
bun run auth          # build and authorize both Spotify sessions
bun run dev           # run the TUI
bun test              # unit tests
bun run typecheck     # TypeScript
bun run engine:test   # native engine tests
```

## Architecture

Spotuify uses two independent Spotify sessions:

- The Web API uses Authorization Code + PKCE with your registered Spotify app.
- Terminal playback uses [librespot](https://github.com/librespot-org/librespot)'s own login and a
  native Rust sidecar.

The Web API token is never passed to librespot. For terminal playback, the TUI sends commands to
the sidecar and treats its local player events as authoritative. It uses the Web API for browsing,
remote-device control, and periodic playback-state reconciliation.
