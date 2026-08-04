/**
 * Command orchestration shared by the CLI commands and the MCP server.
 *
 * An operation performs the routed work — device resolution, runtime-first dispatch, Web API
 * fallback — and returns the machine data plus the human message. Frontends own argument parsing
 * and emission: the CLI feeds the result to its output formatter, the MCP server to a tool result.
 * Domain failures throw (`CliError` and the typed API errors); each frontend maps them itself.
 */
export interface OperationResult<T = unknown> {
  data: T;
  message: string;
}
