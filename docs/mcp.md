# Spotuify MCP server

`spotuify mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio,
so AI agents can search Spotify and control playback through the same routing, sessions, and
output shapes as the CLI.

## Setup

The MCP server reuses the CLI's stored Spotify login and never prompts or opens a browser.
Authenticate once in a terminal:

```sh
spotuify auth
```

When credentials are missing or expired, tool calls answer with an error asking the user to run
`spotuify auth`; `initialize` and tool listing work without any setup.

## Client registration

The server works with any MCP client: register `spotuify mcp` as a stdio server.

Claude Code:

```sh
claude mcp add spotuify -- spotuify mcp
```

Codex CLI:

```sh
codex mcp add spotuify -- spotuify mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.spotuify]
command = "spotuify"
args = ["mcp"]
```

Clients that use the common `mcpServers` JSON convention (e.g., Cursor):

```json
{
  "mcpServers": {
    "spotuify": {
      "command": "spotuify",
      "args": ["mcp"]
    }
  }
}
```

## Runtime behavior

The MCP server follows the same routing as one-shot CLI commands: while the TUI or
`spotuify service run` is open, playback commands go through that runtime's serialized command
stream; otherwise they use Spotify's Web API directly. The server never starts a renderer,
playback engine, or browser, and any number of MCP server instances can run alongside the TUI.

Shutdown follows the MCP stdio convention: the server exits when the client closes its stdin or
sends SIGINT/SIGTERM. Diagnostics go to stderr; stdout carries only protocol messages.

## Tools

| Tool | Kind | Description |
| --- | --- | --- |
| `playback_status` | read | Current playback state: track, device, progress, shuffle, repeat |
| `play` | write | Resume playback, or play a track, episode, album, artist, or playlist |
| `pause` | write | Pause playback |
| `skip` | write | Skip to the next item or return to the previous one |
| `seek` | write | Jump to `position_ms` or move by a signed `offset_ms` |
| `set_volume` | write | Set an absolute `percent` or adjust by a signed `delta` |
| `set_playback_mode` | write | Set shuffle and/or repeat |
| `queue_list` | read | The current item and the upcoming queue |
| `queue_add` | write | Append tracks or episodes to the queue |
| `list_devices` | read | Available Spotify Connect devices |
| `transfer_playback` | write | Move playback to another device |
| `search` | read | Search the catalog by type, up to 50 results per type |
| `get_resource` | read | Details and playable contents for any Spotify URI or URL, with optional track or album artwork |
| `get_lyrics` | read | Lyrics for a track or the currently playing track |
| `save_to_library` | write | Save tracks, episodes, albums, shows, or audiobooks |
| `remove_from_library` | write, destructive | Remove items from the library |
| `list_playlists` | read | The user's playlists |
| `add_playlist_items` | write | Append tracks or episodes to an owned playlist |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) so clients can gate confirmation prompts appropriately.

## Input and output conventions

- `target`, `uris`, and `playlist` parameters accept Spotify URIs (`spotify:track:...`) or
  `open.spotify.com` URLs.
- To show a track or album cover, call `get_resource` with `include_artwork: true`. The result
  contains the usual text and structured metadata plus an MCP image content block. Artwork is
  returned at a moderate source size to keep stdio responses bounded; its original bytes are not
  cropped, resized, or otherwise altered.
- `device` parameters accept a Spotify Connect device ID or name from `list_devices`; omitted,
  commands use the active device.
- Structured tool results (`structuredContent`) use the same snake_case shapes as the CLI's
  `--json` envelope `data` field, documented in [cli.md](cli.md). Two adaptations apply: results
  whose CLI shape is an array are wrapped under a named key (`devices`, `playlists`), and mutation
  results omit the CLI's `ok` flag because MCP conveys success through `isError`.
- Domain failures are tool errors with an actionable message and hint — rate limits include the
  time to retry after — never protocol errors.

## Constraints

- Playback control requires Spotify Premium and a reachable device, exactly like the CLI.
- Playlist contents are listed only for playlists the user owns; Spotify permanently refuses the
  items read for foreign playlists.
- Artwork results include Spotify attribution and a link to the applicable track or album. Clients
  decide how to render MCP image blocks; the structured result retains the source URL as a fallback.
- The lyrics tool uses LRCLIB and Genius, not Spotify.
