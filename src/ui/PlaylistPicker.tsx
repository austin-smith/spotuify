import { filterOwnedPlaylists, useActions } from "../store/actions.ts";
import { listWindowStart } from "../store/rows.ts";
import {
  Overlay,
  OVERLAY_TOP,
  OverlayTitle,
  overlayInnerWidth,
  overlayListHeight,
} from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** Screen row occupied by the focused playlist filter input. */
export const PLAYLIST_PROMPT_ROW = OVERLAY_TOP;

/** Owned-playlist destination picker for the action workflow. */
export function PlaylistPicker({ width, height }: { width: number; height: number }) {
  const target = useActions((s) => s.target);
  const playlists = useActions((s) => s.playlists);
  const loading = useActions((s) => s.playlistsLoading);
  const query = useActions((s) => s.playlistQuery);
  const selected = useActions((s) => s.playlistSelected);
  const busy = useActions((s) => s.busy);
  const error = useActions((s) => s.error);
  const setQuery = useActions((s) => s.setPlaylistQuery);

  if (target === null) return null;

  const visible = filterOwnedPlaylists(playlists, query);
  const inner = overlayInnerWidth(width);
  const listHeight = overlayListHeight(height);
  const start = listWindowStart(visible.length, selected, listHeight);
  const window = visible.slice(start, start + listHeight);
  const status = (() => {
    if (error !== null) return error;
    if (busy) return "adding to playlist…";
    if (loading) return "loading your playlists…";
    if (visible.length === 0) {
      return query.trim().length > 0 ? "no matching owned playlists" : "no owned playlists";
    }
    return `${visible.length} ${visible.length === 1 ? "playlist" : "playlists"}`;
  })();

  return (
    <Overlay
      width={width}
      height={height}
      status={status}
      isError={error !== null}
      hints="↑↓ move · ↵ add · esc back"
      header={
        <box flexDirection="row" gap={1}>
          <OverlayTitle glyph="+" title="ADD TO" />
          <text fg={theme.muted}>{truncate(target.name, Math.max(0, Math.floor(inner / 2)))}</text>
          <text fg={theme.faint}>/</text>
          <input
            value={query}
            onInput={(value) => {
              if (!busy) setQuery(value);
            }}
            placeholder="filter playlists"
            focused={!busy}
            flexGrow={1}
            textColor={theme.text}
            cursorColor={theme.accent}
            placeholderColor={theme.label}
          />
        </box>
      }
    >
      {window.map((playlist, offset) => {
        const active = start + offset === selected;
        return (
          <box key={playlist.id} flexDirection="row" gap={1}>
            <text fg={active ? theme.accent : theme.faint}>{active ? "▌" : " "}</text>
            <text fg={active ? theme.text : theme.muted}>
              {truncate(playlist.name, Math.max(0, inner - 2))}
            </text>
          </box>
        );
      })}
    </Overlay>
  );
}
