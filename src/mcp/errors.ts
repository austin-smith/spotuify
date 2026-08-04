import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asCliError } from "../cli/errors.ts";

/**
 * Map a thrown domain error to an MCP tool result.
 *
 * Domain failures — missing credentials, rate limits, unavailable devices — are tool results, not
 * protocol errors: the model reads them and can act on the hint. Protocol errors stay reserved for
 * what the SDK raises itself (malformed arguments, unknown tools). `asCliError` already carries the
 * complete error taxonomy, including the `spotuify auth` guidance and rate-limit retry times.
 *
 * Error results carry text only: clients validate `structuredContent` against a tool's output
 * schema even on errors, so a structured error object would turn every failure on a
 * schema-declaring tool into a protocol error.
 */
export function toolErrorResult(error: unknown): CallToolResult {
  const cliError = asCliError(error);
  const lines = [cliError.message];
  if (cliError.hint !== undefined) lines.push(`Hint: ${cliError.hint}`);
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
