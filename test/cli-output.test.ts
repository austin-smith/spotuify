import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "bun:test";
import { CliError, ExitCode } from "../src/cli/errors.ts";
import {
  CliOutput,
  machineValue,
  normalizeRuntimePlayback,
} from "../src/cli/output.ts";

class Capture extends Writable {
  chunks: string[] = [];
  columns = 88;

  constructor(readonly isTTY = false) {
    super();
  }
  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: () => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
  text(): string {
    return this.chunks.join("");
  }
}

describe("CLI output", () => {
  test("normalizes nested machine keys to snake_case", () => {
    expect(
      machineValue({ progressMs: 12, nestedValue: [{ deviceId: "x" }] }),
    ).toEqual({ progress_ms: 12, nested_value: [{ device_id: "x" }] });
  });

  test("normalizes runtime status to the canonical Web API shape", () => {
    expect(
      normalizeRuntimePlayback({
        source: "runtime",
        active: true,
        isPlaying: true,
        item: null,
        progressMs: 12,
        durationMs: 34,
        shuffle: true,
        repeat: "track",
        device: { id: "device", name: "Terminal", volumePercent: 80 },
      }),
    ).toEqual({
      active: true,
      isPlaying: true,
      item: null,
      progressMs: 12,
      durationMs: 34,
      shuffle: true,
      repeat: "track",
      contextUri: null,
      device: {
        id: "device",
        name: "Terminal",
        type: null,
        volumePercent: 80,
        isRestricted: null,
      },
    });
  });

  test("wraps JSON in a stable versioned envelope", () => {
    const stdout = new Capture();
    const output = new CliOutput(
      { json: true },
      { stdout, stderr: new Capture(), env: {} },
    );
    output.emit("status", { isPlaying: true }, "ignored");
    expect(JSON.parse(stdout.text())).toEqual({
      schema_version: 1,
      command: "status",
      data: { is_playing: true },
    });
  });

  test("wraps interactive results in the branded Clack presentation", () => {
    const stdout = new Capture(true);
    new CliOutput(
      {},
      {
        stdout,
        stderr: new Capture(true),
        env: { TERM: "xterm-256color" },
      },
    ).emit(
      "status",
      { isPlaying: true },
      "Playing  Song — Artist\n1:23 / 3:45 · off · Device",
    );

    const output = stripVTControlCharacters(stdout.text());
    expect(output).toContain("┌  spotuify status");
    expect(output).toContain("Playing  Song — Artist");
    expect(output).toContain("1:23 / 3:45 · off · Device");
    expect(output).toContain("└");
  });

  test("uses Clack success treatment for mutations", () => {
    const stdout = new Capture(true);
    new CliOutput(
      {},
      {
        stdout,
        stderr: new Capture(true),
        env: { TERM: "xterm-256color" },
      },
    ).emit("pause", { ok: true }, "Playback paused.", "success");

    const output = stripVTControlCharacters(stdout.text());
    expect(output).toContain("spotuify pause");
    expect(output).toContain("◆  Playback paused.");
  });

  test("uses the branded Clack treatment for interactive errors", () => {
    const stderr = new Capture(true);
    new CliOutput(
      {},
      {
        stdout: new Capture(true),
        stderr,
        env: { TERM: "xterm-256color" },
      },
    ).error(
      new CliError(
        "No active playback device.",
        ExitCode.unavailable,
        "unavailable",
        "Run `spotuify device list`.",
      ),
    );

    const output = stripVTControlCharacters(stderr.text());
    expect(output).toContain("┌  spotuify error");
    expect(output).toContain("■  No active playback device.");
    expect(output).toContain("Hint  Run `spotuify device list`.");
    expect(output).toContain("└  Command failed");
  });

  test("keeps explicit plain output undecorated on a TTY", () => {
    const stdout = new Capture(true);
    new CliOutput(
      { plain: true },
      {
        stdout,
        stderr: new Capture(true),
        env: { TERM: "xterm-256color" },
      },
    ).emit("status", {}, "Nothing is playing.");

    expect(stdout.text()).toBe("Nothing is playing.\n");
  });

  test("supports fields and templates for shell composition", () => {
    const fieldOut = new Capture();
    new CliOutput(
      { field: "item.name" },
      { stdout: fieldOut, stderr: new Capture(), env: {} },
    ).emit("status", { item: { name: "Song" } }, "ignored");
    expect(fieldOut.text()).toBe("Song\n");

    const templateOut = new Capture();
    new CliOutput(
      { template: "{item.name} — {item.artist}" },
      { stdout: templateOut, stderr: new Capture(), env: {} },
    ).emit("status", { item: { name: "Song", artist: "Artist" } }, "ignored");
    expect(templateOut.text()).toBe("Song — Artist\n");
  });

  test("prints an empty field without turning successful work into an error", () => {
    const stdout = new Capture();
    new CliOutput(
      { field: "item.missing" },
      { stdout, stderr: new Capture(), env: {} },
    ).emit("status", { item: { name: "Song" } }, "ignored");
    expect(stdout.text()).toBe("\n");
  });

  test("strips terminal control sequences from text while preserving JSON data", () => {
    const unsafe = "Song\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007\u001b[31m!\u001b[0m\rreset";
    const plain = new Capture();
    new CliOutput(
      { plain: true },
      { stdout: plain, stderr: new Capture(), env: {} },
    ).emit("show", { name: unsafe }, unsafe);
    expect(plain.text()).toBe("Songlink!reset\n");

    const json = new Capture();
    new CliOutput(
      { json: true },
      { stdout: json, stderr: new Capture(), env: {} },
    ).emit("show", { name: unsafe }, "ignored");
    expect(
      (JSON.parse(json.text()) as { data: { name: string } }).data.name,
    ).toBe(unsafe);
  });
});
