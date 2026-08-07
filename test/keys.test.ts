import { describe, expect, test } from "bun:test";
import {
  handlePlaybackTransportKey,
  isPlainShortcut,
  type PlaybackTransportTarget,
} from "../src/ui/keys.ts";

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

function transportHarness() {
  const calls: Array<"next" | "previous" | number> = [];
  const target: PlaybackTransportTarget = {
    next: () => calls.push("next"),
    previous: () => calls.push("previous"),
    seekBy: (deltaMs) => calls.push(deltaMs),
  };
  const press = (
    name: string,
    modifiers: Partial<typeof plain & { repeated: boolean }> = {},
  ) =>
    handlePlaybackTransportKey(
      { ...plain, name, repeated: false, ...modifiers },
      target,
    );
  return { calls, press };
}

describe("playback transport keys", () => {
  test("keeps bare arrows on the current track", () => {
    const { calls, press } = transportHarness();

    expect(press("left")).toBeTrue();
    expect(press("right")).toBeTrue();
    expect(calls).toEqual([-5_000, 5_000]);
  });

  test("changes tracks with plain p/n or Ctrl+arrows", () => {
    const { calls, press } = transportHarness();

    expect(press("p")).toBeTrue();
    expect(press("n")).toBeTrue();
    expect(press("left", { ctrl: true })).toBeTrue();
    expect(press("right", { ctrl: true })).toBeTrue();
    expect(calls).toEqual(["previous", "next", "previous", "next"]);
  });

  test("does not steal unsupported modifier combinations", () => {
    const { calls, press } = transportHarness();

    expect(press("n", { ctrl: true })).toBeFalse();
    expect(press("p", { shift: true })).toBeFalse();
    expect(press("right", { shift: true })).toBeFalse();
    expect(press("left", { ctrl: true, meta: true })).toBeFalse();
    expect(calls).toEqual([]);
  });

  test("ignores repeat for track changes but preserves repeated seeking", () => {
    const { calls, press } = transportHarness();

    expect(press("n", { repeated: true })).toBeFalse();
    expect(press("right", { ctrl: true, repeated: true })).toBeFalse();
    expect(press("right", { repeated: true })).toBeTrue();
    expect(calls).toEqual([5_000]);
  });
});
