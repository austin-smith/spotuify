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

  test("option-modified arrows jump to the edges instead of moving a line", () => {
    expect(paletteNavigationCommand(key("up", { option: true }), true)).toEqual({
      kind: "edge",
      edge: "first",
    });
    expect(paletteNavigationCommand(key("down", { option: true }), true)).toEqual({
      kind: "edge",
      edge: "last",
    });
    // Without the modifier the arrows still move by one line.
    expect(paletteNavigationCommand(key("up"), true)).toEqual({
      kind: "move",
      distance: "line",
      direction: -1,
    });
  });

  test("maps home and end to the list edges", () => {
    expect(paletteNavigationCommand(key("home"), true)).toEqual({
      kind: "edge",
      edge: "first",
    });
    expect(paletteNavigationCommand(key("end"), true)).toEqual({
      kind: "edge",
      edge: "last",
    });
    // Edge jumps do not depend on a visible scope: they work the same in a drilled list.
    expect(paletteNavigationCommand(key("home"), false)).toEqual({
      kind: "edge",
      edge: "first",
    });
    expect(paletteNavigationCommand(key("end"), false)).toEqual({
      kind: "edge",
      edge: "last",
    });
  });

  test("keeps rendered-row page movement separate from line movement", () => {
    const calls: string[] = [];
    const target = {
      scope: "all" as const,
      move: (delta: number) => calls.push(`line:${delta}`),
      movePage: (direction: -1 | 1, pageSize: number) =>
        calls.push(`page:${direction}:${pageSize}`),
      moveTo: (edge: "first" | "last") => calls.push(`edge:${edge}`),
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

  test("dispatches home and end to the edge mover, not the steppers", () => {
    const calls: string[] = [];
    const target = {
      scope: "all" as const,
      move: (delta: number) => calls.push(`line:${delta}`),
      movePage: (direction: -1 | 1, pageSize: number) =>
        calls.push(`page:${direction}:${pageSize}`),
      moveTo: (edge: "first" | "last") => calls.push(`edge:${edge}`),
      setScope: () => {},
    };

    expect(
      applyPaletteNavigation(key("end"), target, {
        canChangeScope: true,
        pageSize: 11,
      }),
    ).toBeTrue();
    expect(
      applyPaletteNavigation(key("home"), target, {
        canChangeScope: false,
        pageSize: 11,
      }),
    ).toBeTrue();
    expect(calls).toEqual(["edge:last", "edge:first"]);
  });
});
