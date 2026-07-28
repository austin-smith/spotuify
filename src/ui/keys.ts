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
      { key: "SPACE", action: "play / pause" },
      { key: "N", action: "next" },
      { key: "P", action: "previous" },
      { key: "←/→", action: "seek ±5s" },
      { key: "↑/↓", action: "volume ±5%" },
      { key: "S", action: "shuffle" },
      { key: "Z", action: "repeat" },
    ],
  },
  {
    label: "BROWSE",
    bindings: [
      { key: "/", action: "search" },
      { key: "U", action: "queue" },
      { key: "D", action: "device" },
      { key: "R", action: "resync" },
    ],
  },
  {
    label: "IN SEARCH",
    bindings: [
      { key: "↑/↓", action: "move" },
      { key: "↵", action: "play / open" },
      { key: "CTRL+↵", action: "queue it" },
      { key: "ESC", action: "back / close" },
    ],
  },
  {
    label: "APP",
    bindings: [
      { key: "?", action: "these keys" },
      { key: "Q", action: "quit" },
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
      { key: "D", action: "device" },
      { key: "?", action: "keys" },
      { key: "Q", action: "quit" },
    ];
  }

  return [
    { key: "SPACE", action: state.playing ? "pause" : "play" },
    { key: "/", action: "search" },
    { key: "U", action: "queue" },
    { key: "D", action: "device" },
    { key: "?", action: "keys" },
  ];
}
