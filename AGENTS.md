# spotuify Agent Guide

## Authentication

There are two independent logins. Do not attempt to unify them.

- Web API uses authorization code + PKCE against the user's own registered Spotify app.
- librespot runs its own OAuth flow and caches its own credentials.
- Never pass the Web API token to `librespot --access-token`. Spotify's login5 rejects tokens issued to third-party apps.
- `src/cli.ts auth` prints URLs and waits on a browser. It must never run once the renderer owns the terminal.
- Never log or print token contents.

## Spotify API

- These endpoints return a permanent 403 for apps registered after 2024-11-27, with no replacement: `audio-features`, `audio-analysis`, `recommendations`, related-artists, featured-playlists, category playlists, and 30-second `preview_url`. Do not build features on them.
- Poll `/me/player` on an interval and extrapolate progress locally from a monotonic clock. Do not poll once per second; it burns the rate limit for no visible gain.
- Playlist contents come from `GET /playlists/{id}/items`, and the payload is under each entry's `item` key. `/playlists/{id}/tracks` now returns 403 for *every* playlist, including ones the user owns, so do not "fix" this back to the endpoint the documentation and every tutorial still recommend.
- Only playlists the user owns can be listed. A public playlist belonging to someone else answers 403 even when the user follows it, and a Spotify-owned editorial playlist answers 404. Compare the owner id against `/me` before offering to open one, and say so plainly when it cannot be opened.

## Renderer

- Never call `process.exit()`. Use `renderer.destroy()`, or the terminal is left in a broken state.
- Verify layout with the headless test renderer in `test/`, not by eye. Layout regressions must be caught by a test, not a screenshot.
- Do not size layout regions with hand-counted chrome constants. Compute them and test the result across terminal sizes.

## Branches, Commits, and Pull Requests

- Use plain lowercase kebab-case for branch names. Keep names descriptive and do not include issue numbers, prefixes, or namespaces such as `feature/`, `fix/`, usernames, or agent names.
- Before every commit or amend, show the exact current diff and validation, then get explicit approval. Branch or pull-request requests are not commit approval; later changes require fresh approval.
- Never amend, rebase, squash, reset, rewrite history, or force-push without explicit approval for that exact operation.
- Write commit messages entirely lowercase. Use the imperative mood for the subject, keep each commit focused on one logical change, do not use type or scope prefixes, and do not end the subject with a period. Add a body when the reason or important tradeoffs are not clear from the subject.
- Never add `Co-Authored-By` trailers or any other AI/agent attribution to commits, pull request descriptions, or code. Commits are authored by the maintainer alone.
- Keep each pull request focused on one coherent change.
- Write concise, specific, imperative pull request titles in sentence case. Do not use prefixes or trailing periods, and make the title understandable without the branch name.
- Review the complete diff before opening a pull request. Update the title and description whenever the scope changes, and remove unrelated changes.

## Documentation

- Keep `README.md` for humans: what it is, how to set it up, how to run it. No conversation history, planning notes, or architecture essays.

## Running

```sh
bun run dev              # run the TUI
bun test
bun run typecheck
bun run src/cli.ts auth  # sign in; needs a TTY and a browser
```
