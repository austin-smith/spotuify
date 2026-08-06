import type { MouseEvent } from "@opentui/core";
import {
  LIBRARY_SECTIONS,
  LIBRARY_SECTION_LABEL,
  useLibraryBrowser,
} from "../store/library-browser.ts";
import { filterRows } from "../store/rows.ts";
import { CatalogRows } from "./CatalogRows.tsx";
import {
  Overlay,
  OVERLAY_TOP,
  OverlayTitle,
  overlayInnerWidth,
  overlayListHeight,
  scrollSteps,
} from "./Overlay.tsx";
import { truncate } from "./text.ts";
import { theme } from "./theme.ts";

/** The second header row owns the focused library filter caret. */
export const LIBRARY_PROMPT_ROW = OVERLAY_TOP + 1;

/** Rows available to the library after its two-row header and shared overlay chrome. */
export function libraryListHeight(height: number): number {
  return overlayListHeight(height, 1);
}

const ROOT_NOUN = {
  playlists: "playlist",
  albums: "album",
  artists: "artist",
} as const;

/** Complete, locally filterable Spotify library with in-surface catalog drilling. */
export function LibraryView({ width, height }: { width: number; height: number }) {
  const section = useLibraryBrowser((state) => state.section);
  const roots = useLibraryBrowser((state) => state.roots);
  const drills = useLibraryBrowser((state) => state.drills);
  const frame = drills.at(-1) ?? roots[section];
  const rows = filterRows(frame.rows, frame.filter);
  const selected = frame.selected;
  const query = frame.filter;
  const loading = frame.loading;
  const loaded = frame.loaded;
  const error = frame.error;
  const depth = drills.length + 1;
  const breadcrumb = frame.title ?? null;
  const total = frame.rows.filter((row) => row.kind === "result").length;
  const visibleCount = rows.filter((row) => row.kind === "result").length;
  const inner = overlayInnerWidth(width);
  const listHeight = libraryListHeight(height);

  const status = (() => {
    if (error !== null) return error;
    if (loading || !loaded) {
      return depth > 1
        ? "loading…"
        : `loading ${LIBRARY_SECTION_LABEL[section].toLowerCase()}…`;
    }
    if (depth > 1) {
      if (total === 0) return "nothing here";
      return query.trim().length === 0
        ? `${total} ${total === 1 ? "item" : "items"}`
        : `${visibleCount} of ${total} items`;
    }

    const noun = ROOT_NOUN[section];
    if (total === 0) {
      if (noun === "artist") return "no followed artists";
      if (noun === "album") return "no saved albums";
      return "no playlists";
    }
    return query.trim().length === 0
      ? `${total} ${total === 1 ? noun : `${noun}s`}`
      : `${visibleCount} of ${total} ${total === 1 ? noun : `${noun}s`}`;
  })();

  const hints = depth > 1
    ? inner < 72
      ? "↑↓ move · ↵ play · esc back"
      : "type to filter · ↑↓ move · ↵ play · esc back"
    : inner < 72
      ? "tab section · ↑↓ move · ↵ open/play"
      : "tab section · ↑↓ move · ↵ open/play · esc close";

  const handleMouseScroll = (event: MouseEvent) => {
    const steps = scrollSteps(event);
    if (steps === null) return;
    useLibraryBrowser.getState().move(steps);
    event.stopPropagation();
  };

  return (
    <Overlay
      width={width}
      height={height}
      status={status}
      isError={error !== null}
      hints={hints}
      onMouseScroll={handleMouseScroll}
      header={
        <box flexDirection="column">
          <box flexDirection="row" justifyContent="space-between">
            <OverlayTitle glyph="◆" title="LIBRARY" />
            {depth === 1 ? (
              <box flexDirection="row" gap={2}>
                {LIBRARY_SECTIONS.map((candidate) => (
                  <text
                    key={candidate}
                    fg={candidate === section ? theme.text : theme.label}
                  >
                    {candidate === section ? (
                      <strong>{LIBRARY_SECTION_LABEL[candidate]}</strong>
                    ) : (
                      LIBRARY_SECTION_LABEL[candidate]
                    )}
                  </text>
                ))}
              </box>
            ) : (
              <text fg={theme.muted}>
                {truncate(breadcrumb ?? "", Math.max(0, inner - 14))}
              </text>
            )}
          </box>
          <box flexDirection="row" gap={1}>
            <text fg={theme.accent}>
              <strong>›</strong>
            </text>
            <input
              value={query}
              onInput={useLibraryBrowser.getState().setQuery}
              placeholder={depth === 1 ? `filter ${section}` : "filter this list"}
              focused
              flexGrow={1}
              textColor={theme.text}
              cursorColor={theme.accent}
              placeholderColor={theme.label}
            />
          </box>
        </box>
      }
    >
      <CatalogRows rows={rows} selected={selected} width={inner} height={listHeight} />
    </Overlay>
  );
}
