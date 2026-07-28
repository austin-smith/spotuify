import { describe, expect, test } from "bun:test";
import { classifyCallback } from "../src/auth/loopback.ts";

const STATE = "expected-state";

describe("classifyCallback", () => {
  test("accepts the real redirect", () => {
    expect(classifyCallback(`/callback?code=abc123&state=${STATE}`, STATE)).toEqual({
      kind: "code",
      code: "abc123",
    });
  });

  test("accepts an absolute URL as Bun delivers it", () => {
    expect(
      classifyCallback(`http://127.0.0.1:8989/callback?code=abc123&state=${STATE}`, STATE),
    ).toEqual({ kind: "code", code: "abc123" });
  });

  // The regression that breaks naive listeners: a browser prefetch arriving before the redirect.
  test.each([
    "/favicon.ico",
    "/apple-touch-icon-precomposed.png",
    "/apple-touch-icon.png",
    "/callback",
    "/",
  ])("ignores stray request %s", (path) => {
    expect(classifyCallback(path, STATE)).toEqual({ kind: "ignore" });
  });

  test("reports user denial", () => {
    expect(classifyCallback(`/callback?error=access_denied&state=${STATE}`, STATE)).toEqual({
      kind: "denied",
      reason: "access_denied",
    });
  });

  test("rejects a mismatched state", () => {
    expect(classifyCallback("/callback?code=abc123&state=forged", STATE)).toEqual({
      kind: "state-mismatch",
    });
  });

  test("rejects a missing state even with a valid-looking code", () => {
    expect(classifyCallback("/callback?code=abc123", STATE)).toEqual({ kind: "state-mismatch" });
  });

  // State is validated before the error is read, so a forged callback cannot report anything to us.
  test("checks state before reporting an error", () => {
    expect(classifyCallback("/callback?error=access_denied&state=forged", STATE)).toEqual({
      kind: "state-mismatch",
    });
  });

  test("treats an empty code as a stray request", () => {
    expect(classifyCallback(`/callback?code=&state=${STATE}`, STATE)).toEqual({ kind: "ignore" });
  });
});
