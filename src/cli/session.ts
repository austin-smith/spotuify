import { SpotifyClient } from "../api/client.ts";
import { PlayerApi } from "../api/player.ts";
import type { Me } from "../api/types.ts";
import { tokenStore } from "../auth/flow.ts";
import { resolveBootProfile } from "../auth/profile.ts";
import type { TokenStore } from "../auth/tokens.ts";
import { CliError, ExitCode } from "./errors.ts";

export interface CliSession {
  client: SpotifyClient;
  player: PlayerApi;
  profile(): Promise<Me>;
}

let pendingSession: Promise<CliSession> | undefined;

export async function createCliSession(
  tokens?: TokenStore,
  options: { profilePath?: string } = {},
): Promise<CliSession> {
  const resolvedTokens = tokens ?? (await tokenStore());
  const client = new SpotifyClient(resolvedTokens);
  let pendingProfile: Promise<Me> | undefined;
  return {
    client,
    player: new PlayerApi(client),
    profile() {
      pendingProfile ??= (async () => {
        const authorizationId = await resolvedTokens.authorizationId();
        const { profile } = await resolveBootProfile(
          client,
          authorizationId,
          options.profilePath,
        );
        if (profile === null) {
          throw new CliError(
            "Spotify account details are temporarily unavailable.",
            ExitCode.temporary,
            "profile_unavailable",
            "Try again after Spotify's rate limit clears.",
          );
        }
        return profile;
      })();
      return pendingProfile;
    },
  };
}

/**
 * Create the non-interactive Web API session shared by every direct CLI command.
 *
 * This deliberately never runs either authorization flow and never starts librespot. Commands are
 * therefore safe in scripts, cron, and CI: missing or expired credentials fail with an actionable
 * exit code instead of opening a browser or taking ownership of a Spotify Connect session.
 */
export function cliSession(): Promise<CliSession> {
  pendingSession ??= createCliSession();
  return pendingSession;
}

export function resetCliSessionForTests(): void {
  pendingSession = undefined;
}
