import { SEARCH_SCOPES, type SearchScope } from "../api/search.ts";

export interface PaletteNavigationKey {
  name: string;
  ctrl: boolean;
  shift: boolean;
}

export type PaletteNavigationCommand =
  | { kind: "scope"; delta: -1 | 1 }
  | { kind: "move"; distance: "line" | "page"; direction: -1 | 1 };

/** Translate non-printing palette keys without introducing a hidden navigation mode. */
export function paletteNavigationCommand(
  key: PaletteNavigationKey,
  canChangeScope: boolean,
): PaletteNavigationCommand | null {
  if (key.name === "tab" && canChangeScope) {
    return { kind: "scope", delta: key.shift ? -1 : 1 };
  }
  if (key.name === "up" || (key.ctrl && key.name === "p")) {
    return { kind: "move", distance: "line", direction: -1 };
  }
  if (key.name === "down" || (key.ctrl && key.name === "n")) {
    return { kind: "move", distance: "line", direction: 1 };
  }
  if (key.name === "pageup") return { kind: "move", distance: "page", direction: -1 };
  if (key.name === "pagedown") return { kind: "move", distance: "page", direction: 1 };
  return null;
}

interface PaletteNavigationTarget {
  scope: SearchScope;
  move: (delta: number) => void;
  movePage: (direction: -1 | 1, pageSize: number) => void;
  setScope: (scope: SearchScope) => void;
}

/** Apply the navigation contract shared by the production handler and renderer interaction tests. */
export function applyPaletteNavigation(
  key: PaletteNavigationKey,
  target: PaletteNavigationTarget,
  options: { canChangeScope: boolean; pageSize: number },
): boolean {
  const command = paletteNavigationCommand(key, options.canChangeScope);
  if (command === null) return false;

  if (command.kind === "move") {
    if (command.distance === "line") target.move(command.direction);
    else target.movePage(command.direction, options.pageSize);
    return true;
  }

  const current = SEARCH_SCOPES.indexOf(target.scope);
  const next = (current + command.delta + SEARCH_SCOPES.length) % SEARCH_SCOPES.length;
  const scope = SEARCH_SCOPES[next];
  if (scope !== undefined) target.setScope(scope);
  return true;
}
