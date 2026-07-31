import { stripVTControlCharacters } from "node:util";
import { Writable } from "node:stream";
import { describe, expect, test } from "bun:test";
import {
  CliPresenter,
  PLAIN_HELP,
  supportsRichOutput,
} from "../src/cli/presenter.ts";

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
      supportsRichOutput(new CaptureStream(true), { TERM: "xterm-256color", CI: "true" }),
    ).toBe(false);
  });

  test("keeps piped help stable and free of terminal control sequences", () => {
    const stdout = new CaptureStream(false);
    const presenter = new CliPresenter({ stdout, stderr: new CaptureStream(false) });

    presenter.showHelp();

    expect(stdout.text()).toBe(PLAIN_HELP);
    expect(stripVTControlCharacters(stdout.text())).toBe(stdout.text());
  });

  test("renders restrained Clack help with commands, options, and the redirect URI", () => {
    const stdout = new CaptureStream(true);
    const presenter = new CliPresenter({
      stdout,
      stderr: new CaptureStream(true),
      env: { TERM: "xterm-256color" },
    });

    presenter.showHelp();

    const output = stripVTControlCharacters(stdout.text());
    expect(output).toContain("spotuify spotify in ur terminal");
    expect(output).toContain("Commands");
    expect(output).toContain("auth [options]");
    expect(output).toContain("--force-engine");
    expect(output).toContain("http://127.0.0.1:8989/callback");
    expect(output).toContain("Get started with spotuify auth");
  });

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
});
