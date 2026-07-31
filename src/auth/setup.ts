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

export type ClientIdSetupEvent =
  | { type: "setup-required"; dashboardUrl: string; redirectUri: string }
  | { type: "saved" };

type SetupDependencies = {
  resolve?: () => Promise<ResolvedClientId>;
  hasAuthorization?: (clientId: string) => Promise<boolean>;
  save?: (clientId: string) => Promise<void>;
  question?: (prompt: string) => Promise<string>;
  onEvent?: (event: ClientIdSetupEvent) => void;
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

function reportSetupEvent(event: ClientIdSetupEvent): void {
  if (event.type === "saved") {
    console.log("\nSaved for future use.\n");
    return;
  }
  console.log(
    [
      "Spotify app setup",
      "",
      `1. Create an app: ${event.dashboardUrl}`,
      `2. Add this redirect URI: ${event.redirectUri}`,
      "3. Paste the app’s Client ID below.",
      "",
    ].join("\n"),
  );
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
    onEvent = reportSetupEvent,
  }: SetupDependencies = {},
): Promise<ClientIdSetup> {
  let resolved: ResolvedClientId | undefined;
  try {
    resolved = await resolve();
  } catch (error) {
    if (!(error instanceof MissingClientIdError)) throw error;
  }

  if (options.reset === true && resolved?.source === "environment") {
    throw new Error(
      "Cannot reset Client ID while the SPOTUIFY_CLIENT_ID environment variable is set. " +
        "Update it and run `spotuify auth`, or unset it and run `spotuify auth --reset`.",
    );
  }

  if (options.reset !== true && resolved !== undefined) {
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
  }

  onEvent({ type: "setup-required", dashboardUrl: DASHBOARD_URL, redirectUri: REDIRECT_URI });

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
      onEvent({ type: "saved" });
    },
  };
}
