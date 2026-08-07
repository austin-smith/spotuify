export interface LibraryNavigationKey {
  name: string;
  ctrl: boolean;
  shift: boolean;
  option?: boolean;
}

export type LibraryNavigationCommand =
  | { kind: "section"; delta: -1 | 1 }
  | { kind: "move"; distance: "line" | "page"; direction: -1 | 1 }
  | { kind: "edge"; edge: "first" | "last" };

/** Translate the non-printing keys accepted while the library filter retains focus. */
export function libraryNavigationCommand(
  key: LibraryNavigationKey,
  canChangeSection: boolean,
): LibraryNavigationCommand | null {
  if (key.name === "tab" && canChangeSection) {
    return { kind: "section", delta: key.shift ? -1 : 1 };
  }
  if (key.option === true && key.name === "up") return { kind: "edge", edge: "first" };
  if (key.option === true && key.name === "down") return { kind: "edge", edge: "last" };
  if (key.name === "up" || (key.ctrl && key.name === "p")) {
    return { kind: "move", distance: "line", direction: -1 };
  }
  if (key.name === "down" || (key.ctrl && key.name === "n")) {
    return { kind: "move", distance: "line", direction: 1 };
  }
  if (key.name === "pageup") return { kind: "move", distance: "page", direction: -1 };
  if (key.name === "pagedown") return { kind: "move", distance: "page", direction: 1 };
  if (key.name === "home") return { kind: "edge", edge: "first" };
  if (key.name === "end") return { kind: "edge", edge: "last" };
  return null;
}

interface LibraryNavigationTarget {
  cycleSection: (delta: -1 | 1) => void;
  move: (delta: number) => void;
  movePage: (direction: -1 | 1, pageSize: number) => void;
  moveTo: (edge: "first" | "last") => void;
}

/** Apply the library navigation contract shared by App and interaction tests. */
export function applyLibraryNavigation(
  key: LibraryNavigationKey,
  target: LibraryNavigationTarget,
  options: { canChangeSection: boolean; pageSize: number },
): boolean {
  const command = libraryNavigationCommand(key, options.canChangeSection);
  if (command === null) return false;

  if (command.kind === "section") target.cycleSection(command.delta);
  else if (command.kind === "edge") target.moveTo(command.edge);
  else if (command.distance === "line") target.move(command.direction);
  else target.movePage(command.direction, options.pageSize);
  return true;
}
