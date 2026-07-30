import { describe, expect, test } from "bun:test";

/**
 * Guards against hooks placed below an early return.
 *
 * `App` renders in phases and returns early while loading. A hook below one of those returns is
 * called on the ready render but not the loading one, and React aborts with "Rendered more hooks
 * than during the previous render".
 *
 * This is a source check rather than a render test on purpose: reproducing it needs `boot` to reach
 * `ready`, which means stubbing `/me`, seeding a token cache, and letting the component spawn a real
 * librespot process. A render test that stops short of `ready` passes with the bug present — which
 * is exactly what happened when this was first written.
 */

const HOOK_CALL = /(?<![.\w])(use[A-Z]\w*)\s*\(/g;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

describe("hook order", () => {
  test("App calls no hooks after its first early return", async () => {
    const source = await Bun.file(new URL("../src/ui/App.tsx", import.meta.url)).text();

    const componentStart = source.indexOf("export function App(");
    expect(componentStart).toBeGreaterThan(-1);
    const body = source.slice(componentStart);

    // The first phase guard that returns before the main tree.
    const firstReturn = body.search(/^\s{2}if \(boot\.phase [^)]*\) \{?\s*$/m);
    expect(firstReturn).toBeGreaterThan(-1);

    const offenders: string[] = [];
    for (const match of body.matchAll(HOOK_CALL)) {
      if (match.index === undefined || match.index < firstReturn) continue;
      offenders.push(`${match[1]} at App.tsx:${lineOf(source, componentStart + match.index)}`);
    }

    expect(offenders).toEqual([]);
  });
});
