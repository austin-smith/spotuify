export interface Binding {
  key: string;
  action: string;
}

export interface KeyGroup {
  label: string;
  bindings: Binding[];
}

interface ShortcutKey {
  name: string;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  option?: boolean;
  super?: boolean;
  hyper?: boolean;
}

/** Match a literal letter shortcut without stealing modified terminal/application commands. */
export function isPlainShortcut(
  key: ShortcutKey,
  name: string,
  options: { allowShift?: boolean } = {},
): boolean {
  return (
    key.name === name &&
    (options.allowShift === true || !key.shift) &&
    !key.ctrl &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  );
}

/** What this keyboard labels the modifier next to the spacebar; the key itself is the same. */
const OPTION_KEY = process.platform === "darwin" ? "opt" : "alt";

/**
 * The full keymap, as shown by `?`.
 *
 * Single source of truth: the hint bar picks a few of these rather than keeping its own list, so the
 * two can never disagree about what a key does.
 */
export const KEYMAP: KeyGroup[] = [
  {
    label: "PLAYBACK",
    bindings: [
      { key: "space", action: "play / pause" },
      { key: "n", action: "next" },
      { key: "p", action: "previous" },
      { key: "←/→", action: "seek ±5s" },
      { key: "↑/↓", action: "volume ±5%" },
      { key: "s", action: "shuffle" },
      { key: "z", action: "repeat" },
    ],
  },
  {
    label: "BROWSE",
    bindings: [
      { key: "/", action: "search" },
      { key: "a", action: "actions" },
      { key: "f", action: "save / unsave" },
      { key: "l", action: "lyrics" },
      { key: "u", action: "queue" },
      { key: "c", action: "current context" },
      { key: "y / Y", action: "copy URI / link" },
      { key: "d", action: "device" },
      { key: "r", action: "resync" },
    ],
  },
  {
    // Shared by every list overlay; repeating these per view overflowed an 80×24 card. Home/End
    // also jump to the edges but are absent from laptop keyboards, so the option chord is shown.
    label: "LISTS",
    bindings: [
      { key: "↑/↓", action: "move / scroll" },
      { key: "ctrl+p/n", action: "move" },
      { key: "pgup/pgdn", action: "a page" },
      { key: `${OPTION_KEY}+↑/↓`, action: "top / bottom" },
      { key: "f", action: "follow lyrics" },
      { key: "r", action: "refresh queue" },
      { key: "esc", action: "back / close" },
    ],
  },
  {
    label: "SEARCH",
    bindings: [
      // Spelled out: the ⇧ glyph has ambiguous terminal width and can misalign the column.
      { key: "tab / shift+tab", action: "next / previous scope" },
      { key: "↵", action: "play / open" },
      { key: "ctrl+↵", action: "queue it" },
      { key: "ctrl+space", action: "actions" },
    ],
  },
  {
    label: "APP",
    bindings: [
      { key: "?", action: "these keys" },
      { key: "q", action: "quit" },
    ],
  },
];

/**
 * The few hints worth showing permanently, given what is on screen.
 *
 * Deliberately short and state-dependent: an exhaustive bar is noise, and the full list is one
 * keystroke away behind `?`.
 */
export function barFor(state: {
  playing: boolean;
  hasTrack: boolean;
  canBrowse: boolean;
}): Binding[] {
  if (!state.hasTrack) {
    return [
      ...(state.canBrowse ? [{ key: "/", action: "search" }] : []),
      ...(state.canBrowse ? [{ key: "d", action: "device" }] : []),
      ...(!state.canBrowse ? [{ key: "r", action: "retry account" }] : []),
      { key: "?", action: "keys" },
      { key: "q", action: "quit" },
    ];
  }

  return [
    { key: "space", action: state.playing ? "pause" : "play" },
    ...(state.canBrowse
      ? [
          { key: "/", action: "search" },
          { key: "a", action: "actions" },
        ]
      : []),
    { key: "l", action: "lyrics" },
    { key: "u", action: "queue" },
    ...(state.canBrowse ? [{ key: "d", action: "device" }] : []),
    ...(!state.canBrowse ? [{ key: "r", action: "retry account" }] : []),
    { key: "?", action: "keys" },
  ];
}
