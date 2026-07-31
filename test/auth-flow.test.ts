import { describe, expect, test } from "bun:test";
import { launchBrowser } from "../src/auth/flow.ts";

const URL = "https://accounts.spotify.com/authorize?state=test";

describe("browser authorization launch", () => {
  test.each([
    ["darwin", ["open", URL]],
    ["linux", ["xdg-open", URL]],
    ["win32", ["cmd", "/c", "start", "", URL]],
  ] as const)("launches and detaches the %s opener without waiting", (platform, expected) => {
    let command: string[] | undefined;
    let unreferenced = false;

    const attempted = launchBrowser(URL, platform, (value) => {
      command = value;
      return {
        unref() {
          unreferenced = true;
        },
      };
    });

    expect(attempted).toBe(true);
    expect(command).toEqual([...expected]);
    expect(unreferenced).toBe(true);
  });

  test("reports a synchronous launcher failure without blocking the fallback", () => {
    expect(
      launchBrowser(URL, "linux", () => {
        throw new Error("xdg-open is unavailable");
      }),
    ).toBe(false);
  });
});
