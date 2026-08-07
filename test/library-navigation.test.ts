import { describe, expect, test } from "bun:test";
import {
  applyLibraryNavigation,
  libraryNavigationCommand,
  type LibraryNavigationKey,
} from "../src/ui/library-navigation.ts";

function key(name: string, options: Partial<LibraryNavigationKey> = {}): LibraryNavigationKey {
  return { name, ctrl: false, shift: false, ...options };
}

describe("library navigation", () => {
  test("cycles root sections in both directions", () => {
    expect(libraryNavigationCommand(key("tab"), true)).toEqual({
      kind: "section",
      delta: 1,
    });
    expect(libraryNavigationCommand(key("tab", { shift: true }), true)).toEqual({
      kind: "section",
      delta: -1,
    });
    expect(libraryNavigationCommand(key("tab"), false)).toBeNull();
  });

  test("leaves printable filter characters to the focused input", () => {
    for (const name of ["b", "j", "k", "/", "r"]) {
      expect(libraryNavigationCommand(key(name), true)).toBeNull();
    }
  });

  test("applies line, page, and edge movement without a focus mode", () => {
    const calls: string[] = [];
    const target = {
      cycleSection: (delta: -1 | 1) => calls.push(`section:${delta}`),
      move: (delta: number) => calls.push(`line:${delta}`),
      movePage: (direction: -1 | 1, pageSize: number) =>
        calls.push(`page:${direction}:${pageSize}`),
      moveTo: (edge: "first" | "last") => calls.push(`edge:${edge}`),
    };

    expect(applyLibraryNavigation(key("down"), target, { canChangeSection: true, pageSize: 12 })).toBeTrue();
    expect(applyLibraryNavigation(key("pagedown"), target, { canChangeSection: true, pageSize: 12 })).toBeTrue();
    expect(applyLibraryNavigation(key("up", { option: true }), target, { canChangeSection: true, pageSize: 12 })).toBeTrue();
    expect(applyLibraryNavigation(key("tab"), target, { canChangeSection: true, pageSize: 12 })).toBeTrue();
    expect(calls).toEqual(["line:1", "page:1:12", "edge:first", "section:1"]);
  });
});
