import { stripVTControlCharacters } from "node:util";
import { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  CliPresenter,
  supportsRichOutput,
} from "../src/cli/presenter.ts";
import { runCli } from "../src/cli/program.ts";

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  isTTY: boolean;
  columns = 88;

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
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

describe("CLI presentation", () => {
  test("uses rich output only for human-facing terminals", () => {
    expect(supportsRichOutput(new CaptureStream(true), { TERM: "xterm-256color" })).toBe(true);
    expect(supportsRichOutput(new CaptureStream(false), { TERM: "xterm-256color" })).toBe(false);
    expect(supportsRichOutput(new CaptureStream(true), { TERM: "dumb" })).toBe(false);
    expect(
      supportsRichOutput(new CaptureStream(true), {
        TERM: "xterm-256color",
        NO_COLOR: "1",
      }),
    ).toBe(true);
    expect(
      supportsRichOutput(new CaptureStream(true), { TERM: "xterm-256color", CI: "true" }),
    ).toBe(false);
  });

  test("keeps the Clack layout while honoring NO_COLOR", async () => {
    const stdout = new CaptureStream(true);
    const exitCode = await runCli(["--help"], {
      io: {
        stdout,
        stderr: new CaptureStream(true),
        env: { TERM: "xterm-256color", NO_COLOR: "1" },
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toContain("┌  spotuify spotify in ur terminal");
    expect(stripVTControlCharacters(stdout.text())).toBe(stdout.text());
  });

  test("groups commands and output controls in the branded Clack help", async () => {
    const stdout = new CaptureStream(true);
    const stderr = new CaptureStream(true);
    const exitCode = await runCli(["--help"], {
      io: {
        stdout,
        stderr,
        env: { TERM: "xterm-256color" },
      },
    });

    const output = stripVTControlCharacters(stdout.text());
    expect(exitCode).toBe(0);
    expect(output).toContain("┌  spotuify spotify in ur terminal");
    expect(output).toContain("Playback");
    expect(output).toContain("Browse");
    expect(output).toContain("Library");
    expect(output).toContain("Setup & system");
    expect(output).toContain("General options");
    expect(output).toContain("Output");
    expect(output).toContain("Composition");
    expect(output).not.toContain("--color");
    expect(output).toContain("playlist");
    expect(output).toContain("--output <mode>");
    expect(output).toContain("spotuify help output");
    expect(output).not.toContain("Get started with spotuify auth");
    expect(output.indexOf("Playback")).toBeLessThan(output.indexOf("Browse"));
    expect(output.indexOf("Browse")).toBeLessThan(output.indexOf("Library"));
    expect(output.indexOf("General options")).toBeLessThan(
      output.indexOf("Output"),
    );
    expect(output.indexOf("Output")).toBeLessThan(
      output.indexOf("Composition"),
    );
    expect(stdout.text()).toContain("\u001b[");
    expect(stderr.text()).toBe("");
  });

  test("renders focused output and composition help", async () => {
    const stdout = new CaptureStream(true);
    const stderr = new CaptureStream(true);
    const exitCode = await runCli(["help", "output"], {
      io: {
        stdout,
        stderr,
        env: { TERM: "xterm-256color" },
      },
    });

    const output = stripVTControlCharacters(stdout.text());
    expect(exitCode).toBe(0);
    expect(output).toContain("┌  spotuify output");
    expect(output).toContain("spotuify <command> [output options]");
    expect(output).toContain("Output");
    expect(output).toContain("Composition");
    expect(output).toContain("Examples");
    expect(output).toContain("spotuify status --field item.uri");
    expect(stderr.text()).toBe("");
  });

  test("renders subcommand help from live command metadata", async () => {
    const stdout = new CaptureStream(true);
    const exitCode = await runCli(["playlist", "--help"], {
      io: {
        stdout,
        stderr: new CaptureStream(true),
        env: { TERM: "xterm-256color" },
      },
    });

    const output = stripVTControlCharacters(stdout.text());
    expect(exitCode).toBe(0);
    expect(output).toContain("spotuify playlist");
    expect(output).toContain("add <playlist> <items...>");
    expect(output).toContain("replace <playlist> [items...]");
  });

  test.each([
    { outputOptions: ["--plain"] },
    { outputOptions: ["--output", "plain"] },
  ])(
    "keeps explicitly plain parser errors undecorated on a TTY",
    async ({ outputOptions }) => {
      const stderr = new CaptureStream(true);
      const exitCode = await runCli(
        [...outputOptions, "not-a-command"],
        {
          io: {
            stdout: new CaptureStream(true),
            stderr,
            env: { TERM: "xterm-256color" },
          },
        },
      );

      expect(exitCode).toBe(2);
      expect(stderr.text()).toBe(
        "error: unknown command 'not-a-command'\nRun 'spotuify --help' for usage.\n",
      );
      expect(stripVTControlCharacters(stderr.text())).toBe(stderr.text());
    },
  );

  test("renders both independent Spotify logins as one coherent auth flow", () => {
    const stdout = new CaptureStream(true);
    stdout.columns = 60;
    const presenter = new CliPresenter({
      stdout,
      stderr: new CaptureStream(true),
      env: { TERM: "xterm-256color" },
      hyperlinks: true,
    });
    const webAuthorizationUrl =
      "https://accounts.spotify.com/authorize?client_id=test&response_type=code&state=" +
      "w".repeat(180);
    const playbackAuthorizationUrl =
      "https://accounts.spotify.com/authorize?client_id=playback&response_type=code&state=" +
      "p".repeat(180);

    presenter.beginAuth();
    presenter.checkingWebApi();
    presenter.webAuthenticationEvent({
      type: "authorization-required",
      url: webAuthorizationUrl,
      browserLaunchAttempted: true,
    });
    presenter.webApiAuthorized(
      { id: "account-id", display_name: "Austin", product: "premium", country: "US" },
      Date.now() + 3_600_000,
    );
    presenter.checkingPlayback();
    presenter.engineAuthenticationEvent({
      type: "authorization-required",
      url: playbackAuthorizationUrl,
    });
    presenter.playbackAuthenticationResult("authorized", "unused");
    presenter.finishAuth("authorized");

    const output = stripVTControlCharacters(stdout.text());
    expect(output).toContain("Checking Web API session");
    expect(output).toContain("Web API authorized");
    expect(output).toContain("Austin");
    expect(output).toContain("Checking terminal playback");
    expect(output).toContain("This separate login is used only by the terminal playback engine.");
    expect(output).toContain("Open Spotify authorization ↗");
    expect(output).toContain("Open playback authorization ↗");
    expect(output).toContain("Terminal playback authorized");
    expect(output).toContain("Ready — run spotuify");
    expect(stdout.text()).toContain(webAuthorizationUrl);
    expect(stdout.text()).toContain(playbackAuthorizationUrl);
    expect(output).not.toContain(webAuthorizationUrl);
    expect(output).not.toContain(playbackAuthorizationUrl);
    expect(output.indexOf("Web API authorized")).toBeLessThan(
      output.indexOf("Terminal playback authorized"),
    );
  });

  test("keeps exact raw authorization URLs when terminal hyperlinks are unavailable", () => {
    const stdout = new CaptureStream(true);
    stdout.columns = 60;
    const presenter = new CliPresenter({
      stdout,
      stderr: new CaptureStream(true),
      env: { TERM: "xterm-256color" },
      hyperlinks: false,
    });
    const webAuthorizationUrl =
      "https://accounts.spotify.com/authorize?client_id=test&response_type=code&state=" +
      "w".repeat(180);
    const playbackAuthorizationUrl =
      "https://accounts.spotify.com/authorize?client_id=playback&response_type=code&state=" +
      "p".repeat(180);

    presenter.webAuthenticationEvent({
      type: "authorization-required",
      url: webAuthorizationUrl,
      browserLaunchAttempted: false,
    });
    presenter.engineAuthenticationEvent({
      type: "authorization-required",
      url: playbackAuthorizationUrl,
    });

    expect(stdout.text()).toContain(`${webAuthorizationUrl}\n`);
    expect(stdout.text()).toContain(`${playbackAuthorizationUrl}\n`);
  });

  test("keeps auth progress readable when stdout is piped", () => {
    const stdout = new CaptureStream(false);
    const presenter = new CliPresenter({ stdout, stderr: new CaptureStream(false) });

    presenter.beginAuth();
    presenter.checkingWebApi();
    presenter.webAuthenticationEvent({
      type: "authorization-required",
      url: "https://accounts.spotify.com/authorize?state=web",
      browserLaunchAttempted: false,
    });
    presenter.finishAuth("missing");

    expect(stdout.text()).toContain("Authenticating spotuify…");
    expect(stdout.text()).toContain(
      "If it did not open:\nhttps://accounts.spotify.com/authorize?state=web\n",
    );
    expect(stdout.text()).toContain("Ready with remote playback only");
    expect(stripVTControlCharacters(stdout.text())).toBe(stdout.text());
  });

  test("distinguishes a completed update from an already current installation", () => {
    const currentOutput = new CaptureStream(true);
    const currentPresenter = new CliPresenter({
      stdout: currentOutput,
      stderr: new CaptureStream(true),
      env: { TERM: "xterm-256color" },
    });
    const updatedOutput = new CaptureStream(true);
    const updatedPresenter = new CliPresenter({
      stdout: updatedOutput,
      stderr: new CaptureStream(true),
      env: { TERM: "xterm-256color" },
    });

    currentPresenter.finishUpdate("current");
    updatedPresenter.finishUpdate("updated");

    expect(stripVTControlCharacters(currentOutput.text())).toContain("Up to date");
    expect(stripVTControlCharacters(updatedOutput.text())).toContain("Update complete");
    expect(stripVTControlCharacters(updatedOutput.text())).not.toContain("Up to date");
  });
});
