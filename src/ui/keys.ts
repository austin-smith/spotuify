export interface Binding {
  key: string;
  action: string;
}

export interface KeyGroup {
  label: string;
  bindings: Binding[];
}

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
      { key: "a", action: "go to" },
      { key: "u", action: "queue" },
      { key: "d", action: "device" },
      { key: "r", action: "resync" },
    ],
  },
  {
    label: "IN SEARCH",
    bindings: [
      { key: "↑/↓", action: "move" },
      { key: "↵", action: "play / open" },
      { key: "ctrl+↵", action: "queue it" },
      { key: "esc", action: "back / close" },
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
export function barFor(state: { playing: boolean; hasTrack: boolean }): Binding[] {
  if (!state.hasTrack) {
    return [
      { key: "/", action: "search" },
      { key: "d", action: "device" },
      { key: "?", action: "keys" },
      { key: "q", action: "quit" },
    ];
  }

  return [
    { key: "space", action: state.playing ? "pause" : "play" },
    { key: "/", action: "search" },
    { key: "a", action: "go to" },
    { key: "u", action: "queue" },
    { key: "d", action: "device" },
    { key: "?", action: "keys" },
  ];
}
