import { describe, expect, test } from "bun:test";
import { updateNoticeIsVisible } from "../src/ui/App.tsx";

describe("update notice visibility", () => {
  test("waits until the update is the feedback actually rendered", () => {
    expect(updateNoticeIsVisible("loading", false, false)).toBe(false);
    expect(updateNoticeIsVisible("failed", false, false)).toBe(false);
    expect(updateNoticeIsVisible("ready", true, false)).toBe(false);
    expect(updateNoticeIsVisible("ready", false, true)).toBe(false);
    expect(updateNoticeIsVisible("ready", false, false)).toBe(true);
  });

  test("the setup screen can display its dedicated update row", () => {
    expect(updateNoticeIsVisible("needs-setup", true, true)).toBe(true);
  });
});
