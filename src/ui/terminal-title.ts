import type { Writable } from "node:stream";

type TtyWritable = Writable & { isTTY?: boolean };

const OSC = "\u001B]";
const STRING_TERMINATOR = "\u001B\\";
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;

export const SPOTUIFY_TERMINAL_TITLE = "🕺 spotuify";

function isCi(environment: NodeJS.ProcessEnv): boolean {
  const value = environment["CI"]?.toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

function supportsTerminalTitle(
  output: Writable,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    (output as TtyWritable).isTTY === true &&
    environment["TERM"] !== "dumb" &&
    !isCi(environment)
  );
}

/**
 * Set both the terminal's tab/icon label and window title through the widely supported OSC 0
 * sequence. Control characters are removed so this remains safe if the title becomes dynamic.
 */
export function setTerminalTitle(
  title: string,
  output: Writable = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!supportsTerminalTitle(output, environment)) return false;
  const safeTitle = title.replace(CONTROL_CHARACTERS, "");
  output.write(`${OSC}0;${safeTitle}${STRING_TERMINATOR}`);
  return true;
}

export function setSpotuifyTerminalTitle(
  output: Writable = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return setTerminalTitle(SPOTUIFY_TERMINAL_TITLE, output, environment);
}

export function clearTerminalTitle(
  output: Writable = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return setTerminalTitle("", output, environment);
}
