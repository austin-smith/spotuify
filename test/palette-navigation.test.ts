import { describe, expect, test } from "bun:test";
import {
  applyPaletteNavigation,
  paletteNavigationCommand,
  type PaletteNavigationKey,
} from "../src/ui/palette-navigation.ts";

function key(name: string, options: Partial<PaletteNavigationKey> = {}): PaletteNavigationKey {
  return {
    name,
    ctrl: false,
    shift: false,
    ...options,
  };
}

describe("paletteNavigationCommand", () => {
  test("cycles scope directly instead of entering a hidden focus mode", () => {
    expect(paletteNavigationCommand(key("tab"), true)).toEqual({
      kind: "scope",
      delta: 1,
    });
    expect(paletteNavigationCommand(key("tab", { shift: true }), true)).toEqual({
      kind: "scope",
      delta: -1,
    });
  });

  test("does not change scope where no catalog scope is visible", () => {
    expect(paletteNavigationCommand(key("tab"), false)).toBeNull();
    expect(paletteNavigationCommand(key("tab", { shift: true }), false)).toBeNull();
  });

  test("never reinterprets printable query characters as navigation", () => {
    for (const name of ["j", "k", "/", "g", "G", "y"]) {
      expect(paletteNavigationCommand(key(name), true)).toBeNull();
    }
  });

  test("maps arrow and page keys without changing input focus", () => {
    expect(paletteNavigationCommand(key("up"), true)).toEqual({
      kind: "move",
      distance: "line",
      direction: -1,
    });
    expect(paletteNavigationCommand(key("down"), true)).toEqual({
      kind: "move",
      distance: "line",
      direction: 1,
    });
    expect(paletteNavigationCommand(key("pagedown"), true)).toEqual({
      kind: "move",
      distance: "page",
      direction: 1,
    });
    expect(paletteNavigationCommand(key("p", { ctrl: true }), true)).toEqual({
      kind: "move",
      distance: "line",
      direction: -1,
    });
    expect(paletteNavigationCommand(key("n", { ctrl: true }), true)).toEqual({
      kind: "move",
      distance: "line",
      direction: 1,
    });
  });

  test("keeps rendered-row page movement separate from line movement", () => {
    const calls: string[] = [];
    const target = {
      scope: "all" as const,
      move: (delta: number) => calls.push(`line:${delta}`),
      movePage: (direction: -1 | 1, pageSize: number) =>
        calls.push(`page:${direction}:${pageSize}`),
      setScope: () => {},
    };

    expect(
      applyPaletteNavigation(key("down"), target, {
        canChangeScope: true,
        pageSize: 11,
      }),
    ).toBeTrue();
    expect(
      applyPaletteNavigation(key("pagedown"), target, {
        canChangeScope: true,
        pageSize: 11,
      }),
    ).toBeTrue();
    expect(calls).toEqual(["line:1", "page:1:11"]);
  });
});
