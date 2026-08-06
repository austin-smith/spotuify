import type { MouseEvent } from "@opentui/core";
import { useSearch } from "../store/search.ts";
import { SEARCH_SCOPE_LABEL } from "../api/search.ts";
import {
  Overlay,
  OVERLAY_TOP,
  overlayInnerWidth,
  overlayListHeight,
  scrollSteps,
} from "./Overlay.tsx";
import { CatalogRows } from "./CatalogRows.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/**
 * Screen row the query line sits on.
 *
 * The cover backdrop flattens this row to solid cells: the art is drawn as two-tone half-blocks and
 * the terminal's own block caret composites badly against them.
 */
export const PROMPT_ROW = OVERLAY_TOP;

/**
 * Search palette, overlaid on a dimmed cover.
 *
 * The query stays focused throughout: typing edits it, arrows move the selected result, and Tab
 * changes the scope directly. Printable keys therefore never change meaning behind the user.
 */
export function Palette({ width, height }: { width: number; height: number }) {
  // Frames live in the store; these selectors read whichever one is on top.
  const frames = useSearch((s) => s.frames);
  const query = useSearch((s) => s.query);
  const error = useSearch((s) => s.error);
  const scope = useSearch((s) => s.scope);
  const setQuery = useSearch((s) => s.setQuery);
  const move = useSearch((s) => s.move);
  const showingHome = useSearch((s) => s.showingHome);
  const showingReference = useSearch((s) => s.showingReference);

  void query; // subscribed above so root typing re-renders; value read via store.text()
  const store = useSearch.getState();
  const rows = store.rows();
  const selected = store.selected();
  const loading = store.loading();
  const breadcrumb = store.breadcrumb();
  const text = store.text();
  const drilled = frames.length > 1;
  const scopeLabel = showingReference ? "DIRECT" : SEARCH_SCOPE_LABEL[scope];

  const inner = overlayInnerWidth(width);
  const listHeight = overlayListHeight(height);

  const resultCount = rows.filter((r) => r.kind === "result").length;
  const status = (() => {
    if (error !== null) return error;
    if (loading) {
      if (drilled) return "loading…";
      if (showingHome) return "loading your library…";
      return showingReference ? "resolving Spotify reference…" : "searching…";
    }
    if (drilled) {
      return resultCount === 0 ? "nothing here" : `${resultCount} — type to filter`;
    }
    if (showingHome) {
      const destination =
        scope === "all" ? "tracks, artists, albums and playlists" : scopeLabel.toLowerCase();
      return resultCount === 0
        ? `type to search ${destination}`
        : scope === "all"
          ? "browse highlights — or type to search"
          : `search scope: ${destination}`;
    }
    if (showingReference) {
      return resultCount === 0
        ? "paste a complete Spotify link or URI"
        : "Spotify reference — press enter to open";
    }
    if (resultCount === 0) return "no results";
    return "";
  })();

  // The viewport is derived from the selection, so the wheel walks the selection like the arrows.
  const handleMouseScroll = (event: MouseEvent) => {
    const rows = scrollSteps(event);
    if (rows === null) return;
    move(rows);
    event.stopPropagation();
  };

  const hints = (() => {
    if (drilled) return "type to filter · ↑↓ move · ↵ play · esc back";
    if (showingReference) return "↑↓ move · ↵ open · esc close";
    return inner < 72
      ? "tab scope · ↑↓ move · ↵ open"
      : "tab scope · ↑↓ move · ↵ open · esc close";
  })();

  return (
    <Overlay
      width={width}
      height={height}
      status={status}
      isError={error !== null}
      hints={hints}
      onMouseScroll={handleMouseScroll}
      header={
        <box flexDirection="row" gap={1}>
          <text fg={theme.accent}>
            <strong>{drilled ? "‹" : "›"}</strong>
          </text>
          {breadcrumb !== null ? (
            <text fg={theme.muted}>
              {truncate(breadcrumb, Math.max(0, inner - 24))}
              <span fg={theme.faint}>{text.length > 0 ? `   /${text}` : ""}</span>
            </text>
          ) : (
            <text fg={theme.muted}>
              {"["}
              <strong>{scopeLabel}</strong>
              {"]"}
            </text>
          )}
          <input
            value={text}
            // `onInput` fires per keystroke; `onChange` only commits later, which left the store
            // holding an empty query while the field showed typed text.
            onInput={setQuery}
            // Empty when drilled: the field is collapsed to zero width there and would otherwise
            // render the first character of its placeholder next to the breadcrumb.
            placeholder={drilled ? "" : "search"}
            focused
            width={breadcrumb !== null ? 0 : undefined}
            flexBasis={0}
            flexGrow={breadcrumb === null ? 1 : 0}
            minWidth={breadcrumb === null ? 1 : 0}
            textColor={theme.text}
            cursorColor={theme.accent}
            placeholderColor={theme.label}
          />
        </box>
      }
    >
      <CatalogRows rows={rows} selected={selected} width={inner} height={listHeight} />
    </Overlay>
  );
}
