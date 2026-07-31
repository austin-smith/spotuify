import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  MissingClientIdError,
  REDIRECT_URI,
  resolveClientId,
  saveClientId,
} from "../config.ts";

const DASHBOARD_URL = "https://developer.spotify.com/dashboard";

type SetupDependencies = {
  resolve?: () => Promise<string>;
  save?: (clientId: string) => Promise<void>;
  question?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
};

async function questionInTerminal(prompt: string): Promise<string> {
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("Spotify app setup requires an interactive terminal.");
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

/** Prompt once for missing Spotify app configuration, persist it, and continue authorization. */
export async function ensureClientId({
  resolve = resolveClientId,
  save = saveClientId,
  question = questionInTerminal,
  log = console.log,
}: SetupDependencies = {}): Promise<string> {
  try {
    return await resolve();
  } catch (error) {
    if (!(error instanceof MissingClientIdError)) throw error;
  }

  log(
    [
      "Spotify app setup",
      "",
      `1. Create an app: ${DASHBOARD_URL}`,
      `2. Add this redirect URI: ${REDIRECT_URI}`,
      "3. Paste the app’s Client ID below.",
      "",
    ].join("\n"),
  );

  const clientId = (await question("Client ID: ")).trim();
  if (clientId.length === 0) throw new Error("Client ID cannot be empty.");

  await save(clientId);
  log("\nSaved for future use.\n");
  return clientId;
}
