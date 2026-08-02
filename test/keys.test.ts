import { describe, expect, test } from "bun:test";
import { isPlainShortcut } from "../src/ui/keys.ts";

const plain = {
  name: "c",
  shift: false,
  ctrl: false,
  meta: false,
  option: false,
  super: false,
  hyper: false,
};

describe("isPlainShortcut", () => {
  test("accepts only the literal unmodified shortcut", () => {
    expect(isPlainShortcut(plain, "c")).toBeTrue();
    expect(isPlainShortcut({ ...plain, name: "x" }, "c")).toBeFalse();
    expect(isPlainShortcut({ ...plain, shift: true }, "c")).toBeFalse();

    for (const modifier of ["ctrl", "meta", "option", "super", "hyper"] as const) {
      expect(isPlainShortcut({ ...plain, [modifier]: true }, "c")).toBeFalse();
    }
  });

  test("allows Shift only for shortcuts that assign it a visible variant", () => {
    expect(isPlainShortcut({ ...plain, name: "y", shift: true }, "y", {
      allowShift: true,
    })).toBeTrue();
    expect(isPlainShortcut({ ...plain, name: "y", shift: true, ctrl: true }, "y", {
      allowShift: true,
    })).toBeFalse();
  });
});
