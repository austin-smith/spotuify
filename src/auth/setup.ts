import { createInterface } from "node:readline/promises";
import {
  MissingClientIdError,
  REDIRECT_URI,
  type ResolvedClientId,
  resolveClientIdWithSource,
  saveClientId,
} from "../config.ts";
import { TokenStore } from "./tokens.ts";

const DASHBOARD_URL = "https://developer.spotify.com/dashboard";

type SetupDependencies = {
  resolve?: () => Promise<ResolvedClientId>;
  hasAuthorization?: (clientId: string) => Promise<boolean>;
  save?: (clientId: string) => Promise<void>;
  question?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
};

async function hasStoredAuthorization(clientId: string): Promise<boolean> {
  return (await new TokenStore(clientId).load()) !== null;
}

export interface ClientIdSetup {
  readonly clientId: string;
  /** A prompted Client ID must complete interactive authorization before it can be trusted. */
  readonly requiresAuthorization: boolean;
  /** Persist a prompted Client ID after authorization succeeds. No-op for existing configuration. */
  commit(): Promise<void>;
}

async function questionInTerminal(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new Error("Spotify app setup requires an interactive terminal.");
  }

  const readline = createInterface({ input, output });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

/**
 * Resolve an existing Client ID or collect a replacement without persisting it.
 *
 * Prompted values remain pending until `commit()` is called after successful OAuth. This keeps a
 * typo, denied request, or canceled browser flow from trapping every later setup attempt.
 */
export async function prepareClientId(
  options: { reset?: boolean } = {},
  {
    resolve = resolveClientIdWithSource,
    hasAuthorization = hasStoredAuthorization,
    save = saveClientId,
    question = questionInTerminal,
    log = console.log,
  }: SetupDependencies = {},
): Promise<ClientIdSetup> {
  if (options.reset !== true) {
    try {
      const resolved = await resolve();
      // An environment variable is an explicit non-interactive choice. A config-file value is
      // trusted only after Spotify has issued a credential for that same application.
      if (
        resolved.source === "environment" ||
        (await hasAuthorization(resolved.clientId))
      ) {
        return {
          clientId: resolved.clientId,
          requiresAuthorization: false,
          commit: async () => {},
        };
      }
    } catch (error) {
      if (!(error instanceof MissingClientIdError)) throw error;
    }
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

  let committed = false;
  return {
    clientId,
    requiresAuthorization: true,
    async commit() {
      if (committed) return;
      await save(clientId);
      committed = true;
      log("\nSaved for future use.\n");
    },
  };
}
