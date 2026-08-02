import {
  PlayerCommandRejectedError,
  PremiumRequiredError,
  SpotifyApiError,
  SpotifyLimitError,
} from "../api/client.ts";
import { MissingClientIdError } from "../config.ts";
import { LyricsUnavailableError } from "../api/lyrics.ts";
import { ReauthRequiredError } from "../auth/tokens.ts";
import {
  RuntimeRemoteError,
  RuntimeRequestUncertainError,
  RuntimeUnavailableError,
} from "../runtime/control.ts";

export const ExitCode = {
  success: 0,
  operational: 1,
  usage: 2,
  authentication: 3,
  unavailable: 4,
  unsupported: 5,
  temporary: 6,
  interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCodeValue,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, ExitCode.usage, "usage_error", hint);
}

export function unavailable(message: string, hint?: string): CliError {
  return new CliError(message, ExitCode.unavailable, "unavailable", hint);
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (
    error instanceof MissingClientIdError ||
    error instanceof ReauthRequiredError
  ) {
    return new CliError(
      error.message,
      ExitCode.authentication,
      "authentication_required",
      "Run `spotuify auth` and try again.",
    );
  }
  if (error instanceof RuntimeUnavailableError) {
    return new CliError(
      error.message,
      ExitCode.unavailable,
      "runtime_unavailable",
      "Launch `spotuify` first, or omit --watch to use a one-shot Web API read.",
    );
  }
  if (error instanceof RuntimeRemoteError) {
    const knownExitCodes = new Set<number>(Object.values(ExitCode));
    return new CliError(
      error.message,
      (knownExitCodes.has(error.exitCode)
        ? error.exitCode
        : ExitCode.operational) as ExitCodeValue,
      error.code,
      error.hint,
    );
  }
  if (error instanceof RuntimeRequestUncertainError) {
    return new CliError(
      error.message,
      ExitCode.operational,
      "runtime_confirmation_lost",
      "Check the current playback state before retrying the command.",
    );
  }
  if (error instanceof PremiumRequiredError) {
    return new CliError(
      error.message,
      ExitCode.unsupported,
      "premium_required",
    );
  }
  if (error instanceof SpotifyLimitError) {
    return new CliError(
      error.detail,
      ExitCode.temporary,
      error.quotaExceeded ? "spotify_quota_exceeded" : "spotify_rate_limited",
      error.retryAt === null
        ? "Spotify did not provide a retry time. Try again later."
        : `Try again after ${new Date(error.retryAt).toISOString()}.`,
    );
  }
  if (error instanceof PlayerCommandRejectedError) {
    return new CliError(
      error.message,
      ExitCode.unavailable,
      "playback_rejected",
    );
  }
  if (error instanceof LyricsUnavailableError) {
    return new CliError(
      error.message,
      ExitCode.unavailable,
      "lyrics_unavailable",
    );
  }
  if (error instanceof SpotifyApiError) {
    if (error.status === 401) {
      return new CliError(
        "Spotify authorization expired.",
        ExitCode.authentication,
        "authentication_required",
        "Run `spotuify auth --force` and try again.",
      );
    }
    if (error.status === 403) {
      return new CliError(
        error.detail,
        ExitCode.unsupported,
        "spotify_forbidden",
      );
    }
    if (error.status === 404) {
      return new CliError(
        "Spotify resource not found.",
        ExitCode.unavailable,
        "not_found",
      );
    }
    if (error.status >= 500) {
      return new CliError(
        "Spotify is temporarily unavailable.",
        ExitCode.temporary,
        "spotify_unavailable",
      );
    }
    return new CliError(error.detail, ExitCode.operational, "spotify_error");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new CliError(
      "Operation canceled.",
      ExitCode.interrupted,
      "interrupted",
    );
  }
  return new CliError(
    error instanceof Error ? error.message : String(error),
    ExitCode.operational,
    "operation_failed",
  );
}
