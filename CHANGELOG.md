# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Complete command-line interface covering playback, discovery, library, playlists,
  queue, devices, account, authentication, diagnostics, shell completion, updates, and
  licenses, with human, plain, JSON, JSON Lines, field, template, and quiet output
  modes, stable exit codes, and structured errors. Playback commands use the active
  TUI's runtime when present and fall back to direct Web API operations.
  ([#26](https://github.com/austin-smith/spotuify/pull/26))
- Search scope cycling with Spotify field filters and per-category pagination for
  tracks, artists, albums, and playlists; pasted Spotify links and URIs resolve
  directly, Spotify references can be copied, and the current playback context can be
  opened when Spotify exposes it.
  ([#27](https://github.com/austin-smith/spotuify/pull/27))
- Wheel and trackpad scrolling in the search palette, actions menu, lyrics, and queue
  overlays, plus jump-to-top/bottom with opt/alt+arrows or Home/End, documented in the
  `?` keymap. ([#28](https://github.com/austin-smith/spotuify/pull/28))
- First-party standalone installers for macOS, Linux, and Windows, with transactional
  self-updates through `spotuify update` for standalone installations.
  ([#30](https://github.com/austin-smith/spotuify/pull/30))
- Homebrew support for Linux (x86-64 and arm64) through the existing
  `austin-smith/tap/spotuify` formula.
  ([#35](https://github.com/austin-smith/spotuify/pull/35))

### Changed

- The startup splash settles in a single transition with a fixed wordmark position:
  launches within a 400ms grace window show the wordmark alone, and slower launches
  show one connecting message. Previously three messages flashed in under a second and
  the wordmark jumped a row. ([#29](https://github.com/austin-smith/spotuify/pull/29))

### Fixed

- The queue overlay scrolls through the entire queue with absolute item numbering and
  an up-next range indicator; it previously truncated at one screen with no way to see
  the rest, and its header row clipped one item.
  ([#28](https://github.com/austin-smith/spotuify/pull/28))
- Ctrl+C shuts Spotuify down from every input mode; an active overlay could previously
  consume it, leaving the renderer and native engine running.
  ([#32](https://github.com/austin-smith/spotuify/pull/32))
- The setup and startup-error screens render lowercase shortcut key labels, matching
  actual key behavior and the rest of the interface.
  ([#31](https://github.com/austin-smith/spotuify/pull/31))

## [0.1.1] - 2026-08-01

### Added

- Spotuify branding. ([#17](https://github.com/austin-smith/spotuify/pull/17))

### Changed

- Polished CLI output. ([#16](https://github.com/austin-smith/spotuify/pull/16))

### Fixed

- Spotify app setup can be retried after a failure.
  ([#15](https://github.com/austin-smith/spotuify/pull/15))

## [0.1.0] - 2026-07-31

Initial release.

### Added

- Embedded librespot playback engine with hardened Spotify coordination.
  ([#1](https://github.com/austin-smith/spotuify/pull/1))
- Synchronized lyrics. ([#3](https://github.com/austin-smith/spotuify/pull/3))
- Library and playlist actions. ([#5](https://github.com/austin-smith/spotuify/pull/5))
- Product versioning and package-aware updates.
  ([#4](https://github.com/austin-smith/spotuify/pull/4),
  [#13](https://github.com/austin-smith/spotuify/pull/13))
- Project licensing and third-party dependency notices, available through
  `spotuify licenses`. ([#2](https://github.com/austin-smith/spotuify/pull/2))
- Automated release pipeline publishing signed and notarized macOS builds, Linux
  builds, and a Windows build to GitHub Releases, npm, and Homebrew.
  ([#6](https://github.com/austin-smith/spotuify/pull/6))

[unreleased]: https://github.com/austin-smith/spotuify/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/austin-smith/spotuify/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/austin-smith/spotuify/releases/tag/v0.1.0
