import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import {
  clearTerminalTitle,
  setSpotuifyTerminalTitle,
  setTerminalTitle,
} from "../src/ui/terminal-title.ts";

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  constructor(readonly isTTY: boolean) {
    super();
  }

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

describe("terminal title", () => {
  test("brands an interactive terminal and clears the title on shutdown", () => {
    const output = new CaptureStream(true);
    const environment = { TERM: "xterm-256color" };

    expect(setSpotuifyTerminalTitle(output, environment)).toBe(true);
    expect(clearTerminalTitle(output, environment)).toBe(true);
    expect(output.text()).toBe(
      "\u001B]0;🕺 spotuify\u001B\\\u001B]0;\u001B\\",
    );
  });

  test("does not write terminal control sequences to non-interactive output", () => {
    for (const [isTTY, environment] of [
      [false, { TERM: "xterm-256color" }],
      [true, { TERM: "dumb" }],
      [true, { TERM: "xterm-256color", CI: "true" }],
    ] as const) {
      const output = new CaptureStream(isTTY);
      expect(setSpotuifyTerminalTitle(output, environment)).toBe(false);
      expect(output.text()).toBe("");
    }
  });

  test("removes injected control characters from future dynamic titles", () => {
    const output = new CaptureStream(true);

    expect(
      setTerminalTitle(
        "song\n\u001B]2;injected\u0007",
        output,
        { TERM: "xterm-256color" },
      ),
    ).toBe(true);
    expect(output.text()).toBe("\u001B]0;song]2;injected\u001B\\");
  });
});
