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

interface RepeatableShortcutKey extends ShortcutKey {
  repeated?: boolean;
}

export interface PlaybackTransportTarget {
  next: () => unknown;
  previous: () => unknown;
  seekBy: (deltaMs: number) => unknown;
}

/** Match a literal shortcut without stealing modified terminal/application commands. */
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

/** Ctrl is explicit; every other modifier must remain available to the terminal and focused UI. */
function isCtrlShortcut(key: ShortcutKey, name: string): boolean {
  return (
    key.name === name &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  );
}

type PlaybackTransportCommand =
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "seek"; deltaMs: -5_000 | 5_000 };

/**
 * Resolve main-screen transport controls without claiming modified input accidentally.
 *
 * Track changes are discrete, so a held key must not walk through the queue. Seeking is continuous
 * and deliberately accepts terminal repeat events.
 */
function playbackTransportCommand(
  key: RepeatableShortcutKey,
): PlaybackTransportCommand | null {
  if (key.repeated !== true) {
    if (isPlainShortcut(key, "p") || isCtrlShortcut(key, "left")) {
      return { kind: "previous" };
    }
    if (isPlainShortcut(key, "n") || isCtrlShortcut(key, "right")) {
      return { kind: "next" };
    }
  }

  if (isPlainShortcut(key, "left")) return { kind: "seek", deltaMs: -5_000 };
  if (isPlainShortcut(key, "right")) return { kind: "seek", deltaMs: 5_000 };
  return null;
}

/** Dispatch a recognized transport key and report whether the main-screen handler consumed it. */
export function handlePlaybackTransportKey(
  key: RepeatableShortcutKey,
  target: PlaybackTransportTarget,
): boolean {
  const command = playbackTransportCommand(key);
  if (command === null) return false;

  if (command.kind === "next") void target.next();
  else if (command.kind === "previous") void target.previous();
  else void target.seekBy(command.deltaMs);
  return true;
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
      { key: "p/n", action: "previous / next" },
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
