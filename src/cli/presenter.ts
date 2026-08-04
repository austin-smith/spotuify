import * as clack from "@clack/prompts";
import ansiEscapes from "ansi-escapes";
import type { Command, Help, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { Writable, type Readable } from "node:stream";
import {
  stripVTControlCharacters,
  styleText,
  type InspectColor,
} from "node:util";
import terminalHyperlinks from "supports-hyperlinks";
import type { Me } from "../api/types.ts";
import type { AuthenticationEvent } from "../auth/flow.ts";
import type { ClientIdSetupEvent } from "../auth/setup.ts";
import { TAGLINE } from "../branding.ts";
import type {
  EngineAuthenticationEvent,
  EngineAuthenticationResult,
} from "../engine/librespot.ts";
import type { UpdateCommandResult } from "../update-command.ts";

type TtyWritable = Writable & { isTTY?: boolean; columns?: number };

class PresentationBuffer extends Writable {
  readonly chunks: string[] = [];
  readonly isTTY = true;

  constructor(readonly columns: number) {
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

  getColorDepth(): number {
    return 8;
  }

  hasColors(): boolean {
    return true;
  }
}

class NoColorWritable extends Writable {
  readonly isTTY: boolean;
  readonly columns?: number;

  constructor(private readonly target: Writable) {
    super();
    const terminal = target as TtyWritable;
    this.isTTY = terminal.isTTY === true;
    this.columns = terminal.columns;
  }

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.target.write(stripVTControlCharacters(chunk.toString()), callback);
  }
}

export type HumanPresentation = "detail" | "success" | "stream";

export interface CliPresenterOptions {
  input?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  hyperlinks?: boolean;
  rich?: boolean;
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

function supportsColorOutput(
  output: Writable,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    supportsRichOutput(output, environment) &&
    environment["NO_COLOR"] === undefined
  );
}

function ensureNewline(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

function terminalSafe(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g,
    "",
  );
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
  readonly colorStdout: boolean;
  readonly colorStderr: boolean;
  readonly hyperlinks: boolean;

  constructor({
    input = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    hyperlinks = terminalHyperlinks.stdout,
    rich = true,
  }: CliPresenterOptions = {}) {
    this.input = input;
    this.richStdout = rich && supportsRichOutput(stdout, env);
    this.richStderr = rich && supportsRichOutput(stderr, env);
    this.colorStdout = rich && supportsColorOutput(stdout, env);
    this.colorStderr = rich && supportsColorOutput(stderr, env);
    this.stdout =
      this.richStdout && !this.colorStdout
        ? new NoColorWritable(stdout)
        : stdout;
    this.stderr =
      this.richStderr && !this.colorStderr
        ? new NoColorWritable(stderr)
        : stderr;
    this.hyperlinks = hyperlinks && this.colorStdout;
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

  private helpRows(
    entries: { term: string; description: string }[],
    helper: Help,
    output: Writable,
  ): string[] {
    if (entries.length === 0) return [];
    const termWidth = Math.max(
      ...entries.map(({ term }) => helper.displayWidth(term)),
    );
    return entries.flatMap(({ term, description }) =>
      helper
        .formatItem(
          this.brand(term, output),
          termWidth,
          this.dim(description, output),
          helper,
        )
        .split("\n"),
    );
  }

  private helpSection(
    title: string,
    rows: string[],
    output: Writable,
  ): void {
    if (rows.length === 0) return;
    this.guidedMessage([this.bold(title, output), "", ...rows], output);
  }

  private groupedHelpSections<T extends Command | Option>(
    unsorted: T[],
    visible: T[],
    groupFor: (item: T) => string,
    rowFor: (item: T) => { term: string; description: string },
    helper: Help,
    output: Writable,
  ): void {
    const groups = helper.groupItems(unsorted, visible, groupFor);
    for (const [title, items] of groups) {
      this.helpSection(
        title.replace(/:$/, ""),
        this.helpRows(items.map(rowFor), helper, output),
        output,
      );
    }
  }

  /** Render Commander metadata using the same Clack language as auth and update. */
  formatHelp(command: Command, helper: Help): string {
    const columns = Math.max(
      52,
      Math.min((this.stdout as TtyWritable).columns ?? 88, 120),
    );
    const output = new PresentationBuffer(columns);
    helper.helpWidth = columns - 6;
    const root = command.parent === null;
    this.intro(root ? TAGLINE : command.name(), output);

    const usage = helper.commandUsage(command);
    const description = helper.commandDescription(command);
    this.guidedMessage(
      [
        ...(description.length > 0 && !root
          ? [this.bold(description, output), ""]
          : []),
        `${this.dim("Usage", output)}  ${this.brand(usage, output)}`,
      ],
      output,
      0,
    );

    const arguments_ = helper.visibleArguments(command).map((argument) => ({
      term: helper.argumentTerm(argument),
      description: helper.argumentDescription(argument),
    }));
    this.helpSection(
      "Arguments",
      this.helpRows(arguments_, helper, output),
      output,
    );

    this.groupedHelpSections(
      [...command.commands],
      helper.visibleCommands(command),
      (child) => child.helpGroup() || "Commands",
      (child) => ({
        term: helper.subcommandTerm(child),
        description: helper.subcommandDescription(child),
      }),
      helper,
      output,
    );

    this.groupedHelpSections(
      [...command.options],
      helper.visibleOptions(command),
      (option) => option.helpGroupHeading ?? "Options",
      (option) => ({
        term: helper.optionTerm(option),
        description: helper.optionDescription(option),
      }),
      helper,
      output,
    );

    if (!root) {
      const inheritedOptions = [];
      for (
        let ancestor = command.parent;
        ancestor !== null;
        ancestor = ancestor.parent
      ) {
        inheritedOptions.push(...ancestor.options);
      }
      this.groupedHelpSections(
        inheritedOptions,
        helper.visibleGlobalOptions(command),
        (option) => option.helpGroupHeading ?? "Global options",
        (option) => ({
          term: helper.optionTerm(option),
          description: helper.optionDescription(option),
        }),
        helper,
        output,
      );
    }

    if (root) {
      this.guidedMessage(
        [
          this.bold("More about structured output", output),
          "",
          this.brand("spotuify help output", output),
        ],
        output,
      );
    }

    clack.outro("", { output, withGuide: true });
    return output.text();
  }

  /** Render the structured-output help topic from the root option metadata. */
  formatOutputHelp(command: Command, helper: Help): string {
    const columns = Math.max(
      52,
      Math.min((this.stdout as TtyWritable).columns ?? 88, 120),
    );
    const output = new PresentationBuffer(columns);
    helper.helpWidth = columns - 6;
    this.intro("output", output);
    this.guidedMessage(
      [
        `${this.dim("Usage", output)}  ${this.brand(
          "spotuify <command> [output options]",
          output,
        )}`,
      ],
      output,
      0,
    );

    for (const title of ["Output", "Composition"]) {
      const options = command.options.filter(
        (option) => option.helpGroupHeading === title && !option.hidden,
      );
      this.helpSection(
        title,
        this.helpRows(
          options.map((option) => ({
            term: helper.optionTerm(option),
            description: helper.optionDescription(option),
          })),
          helper,
          output,
        ),
        output,
      );
    }

    this.helpSection(
      "Examples",
      [
        "spotuify status --json",
        "spotuify queue list --output json",
        "spotuify status --field item.uri",
        "spotuify status --template '{item.name} — {item.artist}'",
        "spotuify pause --quiet",
      ].map((example) => this.brand(example, output)),
      output,
    );
    clack.outro("", { output, withGuide: true });
    return output.text();
  }

  showResult(
    command: string,
    message: string,
    presentation: Exclude<HumanPresentation, "stream"> = "detail",
  ): void {
    if (!this.richStdout) {
      this.line(this.stdout, message);
      return;
    }
    this.intro(command.replaceAll(".", " "));
    if (presentation === "success") {
      clack.log.success(message, {
        output: this.stdout,
        withGuide: true,
      });
    } else {
      const lines = message.split("\n");
      const first = lines.findIndex((line) => line.length > 0);
      if (first >= 0) lines[first] = this.bold(lines[first]!);
      this.guidedMessage(lines, this.stdout, 0);
    }
    clack.outro("", { output: this.stdout, withGuide: true });
  }

  showCommandError(message: string, hint?: string): void {
    message = terminalSafe(message);
    hint = hint === undefined ? undefined : terminalSafe(hint);
    if (!this.richStderr) {
      this.line(this.stderr, `Error: ${message}`);
      if (hint !== undefined) this.line(this.stderr, `Hint: ${hint}`);
      return;
    }
    this.intro("error", this.stderr);
    clack.log.error(message, {
      output: this.stderr,
      withGuide: true,
    });
    if (hint !== undefined) {
      this.guidedMessage(
        `${this.dim("Hint", this.stderr)}  ${hint}`,
        this.stderr,
        0,
      );
    }
    clack.outro("Command failed", {
      output: this.stderr,
      withGuide: true,
    });
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
    this.showCommandError(message);
  }
}
