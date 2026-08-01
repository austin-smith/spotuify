import * as clack from "@clack/prompts";
import ansiEscapes from "ansi-escapes";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { styleText, type InspectColor } from "node:util";
import terminalHyperlinks from "supports-hyperlinks";
import type { Me } from "../api/types.ts";
import type { AuthenticationEvent } from "../auth/flow.ts";
import type { ClientIdSetupEvent } from "../auth/setup.ts";
import { REDIRECT_URI } from "../config.ts";
import type {
  EngineAuthenticationEvent,
  EngineAuthenticationResult,
} from "../engine/librespot.ts";
import type { UpdateCommandResult } from "../update-command.ts";

const COMMANDS = [
  ["auth [options]", "Authorize the Web API and terminal playback"],
  ["whoami", "Show the authenticated Spotify account"],
  ["licenses", "Show software licenses and third-party notices"],
  ["update [--check]", "Install an update, or only check for one"],
  ["-v, --version", "Show the product version"],
] as const;

const AUTH_USAGE = "spotuify auth [--force] [--force-engine] [--reset]";
const UPDATE_USAGE = "spotuify update [--check]";

export const PLAIN_HELP = `spotuify — spotify in ur terminal

Usage:
  spotuify                   Launch the TUI
  spotuify auth [options]    Authorize with Spotify
  spotuify whoami            Show the authenticated account
  spotuify licenses          Show software licenses and third-party notices
  spotuify update [--check]  Install an available update
  spotuify -v, --version     Show the product version

Auth options:
  --force                    Reauthorize the Web API
  --force-engine             Reauthorize terminal playback
  --reset                    Replace the configured Spotify Client ID

Redirect URI to register in your Spotify app:
  ${REDIRECT_URI}
`;

type TtyWritable = Writable & { isTTY?: boolean; columns?: number };

export interface CliPresenterOptions {
  input?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  hyperlinks?: boolean;
}

export class CliCancelledError extends Error {
  constructor() {
    super("Operation canceled.");
    this.name = "CliCancelledError";
  }
}

function isCi(environment: NodeJS.ProcessEnv): boolean {
  const value = environment["CI"]?.toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export function supportsRichOutput(
  output: Writable,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (output as TtyWritable).isTTY === true &&
    environment["TERM"] !== "dumb" &&
    !isCi(environment)
  );
}

function ensureNewline(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

function accountName(me: Me): string {
  return me.display_name ?? me.id;
}

function accountDetails(me: Me): string[] {
  const details: string[] = [`Account  ${me.id}`];
  if (me.product !== undefined) {
    details.push(`Plan     ${me.product[0]?.toUpperCase() ?? ""}${me.product.slice(1)}`);
  }
  if (me.country !== undefined) details.push(`Market   ${me.country.toUpperCase()}`);
  return details;
}

/**
 * One presentation boundary for every non-TUI command.
 *
 * Rich output is deliberately limited to real interactive terminals. Pipes, CI, `TERM=dumb`,
 * version output, and legal notices retain stable plain text with no cursor control or animation.
 */
export class CliPresenter {
  readonly input: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly richStdout: boolean;
  readonly richStderr: boolean;
  readonly hyperlinks: boolean;

  constructor({
    input = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    hyperlinks = terminalHyperlinks.stdout,
  }: CliPresenterOptions = {}) {
    this.input = input;
    this.stdout = stdout;
    this.stderr = stderr;
    this.richStdout = supportsRichOutput(stdout, env);
    this.richStderr = supportsRichOutput(stderr, env);
    this.hyperlinks = hyperlinks;
  }

  private style(format: InspectColor | readonly InspectColor[], text: string, output: Writable) {
    return styleText(format, text, { stream: output as NodeJS.WritableStream });
  }

  private brand(text: string, output: Writable = this.stdout): string {
    return this.style(["green", "bold"], text, output);
  }

  private dim(text: string, output: Writable = this.stdout): string {
    return this.style("dim", text, output);
  }

  private bold(text: string, output: Writable = this.stdout): string {
    return this.style("bold", text, output);
  }

  private line(output: Writable, message = ""): void {
    output.write(ensureNewline(message));
  }

  private intro(section: string, output = this.stdout): void {
    clack.intro(`${this.brand("spotuify", output)} ${this.dim(section, output)}`, {
      output,
      withGuide: true,
    });
  }

  private guidedMessage(
    message: string | string[],
    output = this.stdout,
    spacing = 1,
  ): void {
    const bar = this.dim(clack.S_BAR, output);
    clack.log.message(message, {
      output,
      spacing,
      symbol: bar,
      secondarySymbol: bar,
      withGuide: true,
    });
  }

  private authorizationLink(label: string, url: string): void {
    if (this.hyperlinks) {
      const linkedLabel = ansiEscapes.link(
        this.style(["green", "underline"], label, this.stdout),
        url,
      );
      this.guidedMessage(`${linkedLabel} ${this.dim("↗")}`, this.stdout, 0);
      return;
    }

    // An undecorated line remains copy-safe in terminals without OSC 8 hyperlink support.
    this.guidedMessage(this.dim("Open manually if needed:"), this.stdout, 0);
    this.line(this.stdout, url);
  }

  showHelp(output: Writable = this.stdout): void {
    const rich = output === this.stderr ? this.richStderr : this.richStdout;
    if (!rich) {
      output.write(PLAIN_HELP);
      return;
    }

    this.intro("spotify in ur terminal", output);
    this.guidedMessage(
      [
        this.bold("Commands", output),
        "",
        `  ${this.brand("spotuify", output)}             Launch the TUI`,
        ...COMMANDS.map(
          ([command, description]) =>
            `  ${this.brand(command.padEnd(21), output)} ${description}`,
        ),
      ],
      output,
    );
    this.guidedMessage(
      [
        this.bold("Auth options", output),
        "",
        `  ${this.brand("--force".padEnd(21), output)} Reauthorize the Web API`,
        `  ${this.brand("--force-engine".padEnd(21), output)} Reauthorize terminal playback`,
        `  ${this.brand("--reset".padEnd(21), output)} Replace the Spotify Client ID`,
      ],
      output,
    );
    this.guidedMessage(
      [this.bold("Spotify redirect URI", output), "", `  ${REDIRECT_URI}`],
      output,
    );
    clack.outro(`Get started with ${this.brand("spotuify auth", output)}`, {
      output,
      withGuide: true,
    });
  }

  usageError(message: string, command: "auth" | "update" | "unknown"): void {
    const usage = command === "auth" ? AUTH_USAGE : command === "update" ? UPDATE_USAGE : null;
    if (!this.richStderr) {
      this.line(this.stderr, message);
      if (usage !== null) this.line(this.stderr, `Usage: ${usage}`);
      else {
        this.line(this.stderr);
        this.stderr.write(PLAIN_HELP);
      }
      return;
    }

    this.intro("command error", this.stderr);
    clack.log.error(message, { output: this.stderr, withGuide: true });
    if (usage === null) {
      this.guidedMessage(`Run ${this.bold("spotuify --help", this.stderr)} to see every command.`, this.stderr, 0);
    } else {
      this.guidedMessage(`${this.dim("Usage", this.stderr)}  ${usage}`, this.stderr, 0);
    }
    clack.outro("Nothing changed", { output: this.stderr, withGuide: true });
  }

  showAccount(me: Me): void {
    if (!this.richStdout) {
      const details = [me.product, me.country].filter((value) => value !== undefined);
      const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
      this.line(this.stdout, `${accountName(me)}${suffix}`);
      return;
    }

    this.intro("whoami");
    clack.log.success(`Signed in as ${this.bold(accountName(me))}`, {
      output: this.stdout,
      withGuide: true,
    });
    this.guidedMessage(accountDetails(me).map((detail) => this.dim(detail)), this.stdout, 0);
    clack.outro(this.brand("Authenticated"), { output: this.stdout, withGuide: true });
  }

  beginAuth(): void {
    if (this.richStdout) this.intro("auth");
    else this.line(this.stdout, "Authenticating spotuify…");
  }

  clientIdSetupEvent(event: ClientIdSetupEvent): void {
    if (event.type === "saved") {
      if (this.richStdout) {
        clack.log.success("Spotify app configuration saved", {
          output: this.stdout,
          withGuide: true,
        });
      } else this.line(this.stdout, "Spotify app configuration saved.");
      return;
    }

    const instructions = [
      `1. Create an app: ${event.dashboardUrl}`,
      `2. Add this redirect URI: ${event.redirectUri}`,
      "3. Paste the app’s Client ID below.",
    ].join("\n");
    if (this.richStdout) {
      clack.note(instructions, "Spotify app setup", {
        output: this.stdout,
        withGuide: true,
      });
    } else {
      this.line(this.stdout, "Spotify app setup");
      this.line(this.stdout, instructions);
    }
  }

  async askClientId(): Promise<string> {
    const input = this.input as Readable & { isTTY?: boolean };
    const output = this.stdout as TtyWritable;
    if (input.isTTY !== true || output.isTTY !== true) {
      throw new Error("Spotify app setup requires an interactive terminal.");
    }

    if (this.richStdout) {
      const result = await clack.text({
        message: "Spotify Client ID",
        placeholder: "Paste the Client ID from your app dashboard",
        input: this.input,
        output: this.stdout,
        withGuide: true,
        validate(value) {
          if (value === undefined || value.trim().length === 0) {
            return "Client ID cannot be empty";
          }
        },
      });
      if (clack.isCancel(result)) {
        clack.cancel("Setup canceled", { output: this.stdout, withGuide: true });
        throw new CliCancelledError();
      }
      return result;
    }

    const readline = createInterface({ input, output });
    try {
      return await readline.question("Client ID: ");
    } finally {
      readline.close();
    }
  }

  checkingWebApi(): void {
    if (this.richStdout) {
      clack.log.step("Checking Web API session", { output: this.stdout, withGuide: true });
    } else this.line(this.stdout, "Checking Web API session…");
  }

  webAuthenticationEvent(event: AuthenticationEvent): void {
    switch (event.type) {
      case "cache-hit":
      case "token-refreshed":
        return;
      case "refresh-failed":
        if (this.richStdout) {
          clack.log.warn(`Cached session could not be refreshed: ${event.message}`, {
            output: this.stdout,
            withGuide: true,
          });
        } else this.line(this.stdout, `Cached session could not be refreshed: ${event.message}`);
        return;
      case "authorization-required": {
        const action = event.browserLaunchAttempted
          ? "Continue authorization in your browser"
          : "Browser launch failed — open the URL below";
        if (this.richStdout) {
          clack.log.step(action, { output: this.stdout, withGuide: true });
          this.authorizationLink("Open Spotify authorization", event.url);
          this.guidedMessage(this.dim("Waiting for Web API approval…"), this.stdout, 0);
        } else {
          this.line(this.stdout, `${action}.`);
          this.line(this.stdout, "If it did not open:");
          this.line(this.stdout, event.url);
          this.line(this.stdout, "Waiting for Web API approval…");
        }
      }
    }
  }

  webApiAuthorized(me: Me | null, expiresAt: number): void {
    const expiry = new Date(expiresAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    if (this.richStdout) {
      clack.log.success("Web API authorized", { output: this.stdout, withGuide: true });
      if (me === null) {
        clack.log.warn(
          "Spotify is rate-limiting account details; authorization still succeeded",
          { output: this.stdout, withGuide: true, spacing: 0 },
        );
      } else {
        this.guidedMessage(
          [
            this.bold(accountName(me)),
            this.dim(
              [
                me.product === undefined ? null : `${me.product[0]?.toUpperCase() ?? ""}${me.product.slice(1)}`,
                me.country?.toUpperCase(),
                `session until ${expiry}`,
              ]
                .filter((value) => value !== null && value !== undefined)
                .join(" · "),
            ),
          ],
          this.stdout,
          0,
        );
      }
    } else if (me === null) {
      this.line(
        this.stdout,
        "Web API authorized, but Spotify is rate-limiting account details.",
      );
      this.line(this.stdout, `Session expires at ${expiry}.`);
    } else {
      this.line(this.stdout, `Web API authorized as ${accountName(me)}.`);
      this.line(this.stdout, `Session expires at ${expiry}.`);
    }
  }

  premiumWarning(): void {
    const message = "Playback control requires Spotify Premium";
    if (this.richStdout) {
      clack.log.warn(message, { output: this.stdout, withGuide: true });
    } else this.line(this.stdout, `Warning: ${message}.`);
  }

  checkingPlayback(): void {
    if (this.richStdout) {
      clack.log.step("Checking terminal playback", { output: this.stdout, withGuide: true });
    } else this.line(this.stdout, "Checking terminal playback…");
  }

  engineAuthenticationEvent(event: EngineAuthenticationEvent): void {
    if (event.type === "diagnostic") return;

    if (this.richStdout) {
      clack.log.step("Continue with the second Spotify authorization", {
        output: this.stdout,
        withGuide: true,
      });
      this.guidedMessage(
        this.dim("This separate login is used only by the terminal playback engine."),
        this.stdout,
        0,
      );
      this.authorizationLink("Open playback authorization", event.url);
      this.guidedMessage(this.dim("Waiting for terminal playback approval…"), this.stdout, 0);
    } else {
      this.line(this.stdout, "A second Spotify authorization is required.");
      this.line(this.stdout, "This separate login is used only by terminal playback.");
      this.line(this.stdout, "Open:");
      this.line(this.stdout, event.url);
      this.line(this.stdout, "Waiting for terminal playback approval…");
    }
  }

  playbackAuthenticationResult(
    result: EngineAuthenticationResult,
    missingMessage: string,
    diagnostic?: string,
  ): void {
    const readableDiagnostic = diagnostic?.replace(/^spotuify engine failed:\s*/i, "");
    const details = readableDiagnostic === undefined ? "" : ` ${readableDiagnostic}`;
    if (this.richStdout) {
      switch (result) {
        case "authorized":
          clack.log.success("Terminal playback authorized", {
            output: this.stdout,
            withGuide: true,
          });
          this.guidedMessage(
            this.dim("spotuify will appear as a Spotify Connect device."),
            this.stdout,
            0,
          );
          return;
        case "missing":
          clack.log.warn("Terminal playback engine is unavailable", {
            output: this.stdout,
            withGuide: true,
          });
          this.guidedMessage(
            [missingMessage, this.dim("Remote Spotify devices can still be controlled.")],
            this.stdout,
            0,
          );
          return;
        case "timed-out":
          clack.log.warn("Terminal playback authorization timed out", {
            output: this.stdout,
            withGuide: true,
          });
          return;
        case "failed":
          clack.log.warn(`Terminal playback authorization did not complete.${details}`, {
            output: this.stdout,
            withGuide: true,
          });
          return;
      }
    }

    switch (result) {
      case "authorized":
        this.line(this.stdout, "Terminal playback authorized.");
        return;
      case "missing":
        this.line(this.stdout, `Terminal playback unavailable. ${missingMessage}`);
        this.line(this.stdout, "Remote Spotify devices can still be controlled.");
        return;
      case "timed-out":
        this.line(this.stdout, "Terminal playback authorization timed out.");
        return;
      case "failed":
        this.line(this.stdout, `Terminal playback authorization did not complete.${details}`);
    }
  }

  finishAuth(playback: EngineAuthenticationResult): void {
    if (!this.richStdout) {
      this.line(
        this.stdout,
        playback === "authorized"
          ? "Ready. Run `spotuify`."
          : "Ready with remote playback only. Run `spotuify`.",
      );
      return;
    }
    const message =
      playback === "authorized"
        ? `${this.brand("Ready")} ${this.dim("— run spotuify")}`
        : `${this.style("yellow", "Ready with remote playback only", this.stdout)} ${this.dim("— run spotuify")}`;
    clack.outro(message, { output: this.stdout, withGuide: true });
  }

  beginUpdate(): void {
    if (this.richStdout) this.intro("update");
  }

  updateMessage(message: string): void {
    if (this.richStdout) {
      clack.log.message(message, {
        output: this.stdout,
        symbol: this.brand(clack.S_STEP_SUBMIT),
        secondarySymbol: this.dim(clack.S_BAR),
        withGuide: true,
      });
    } else this.line(this.stdout, message);
  }

  updateError(message: string): void {
    if (this.richStderr) clack.log.error(message, { output: this.stderr });
    else this.line(this.stderr, message);
  }

  finishUpdate(status: UpdateCommandResult["status"]): void {
    if (!this.richStdout) return;
    const messages = {
      current: () => this.brand("Up to date"),
      updated: () => this.brand("Update complete"),
      available: () => this.style("yellow", "Update available", this.stdout),
      failed: () => this.style("red", "Update did not complete", this.stdout),
    } satisfies Record<UpdateCommandResult["status"], () => string>;
    const message = messages[status]();
    clack.outro(message, { output: this.stdout, withGuide: true });
  }

  fatal(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (!this.richStderr) {
      this.line(this.stderr, message);
      return;
    }
    this.intro("error", this.stderr);
    clack.log.error(message, { output: this.stderr, withGuide: true });
    clack.outro("Command failed", { output: this.stderr, withGuide: true });
  }
}
