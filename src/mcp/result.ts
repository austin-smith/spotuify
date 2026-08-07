import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OperationResult } from "../cli/operations/types.ts";
import { machineValue } from "../cli/output.ts";
import { toolErrorResult } from "./errors.ts";

/**
 * Wrap an operation result as an MCP tool result.
 *
 * `structuredContent` passes through `machineValue`, so tool output uses the same snake_case
 * shapes the CLI's `--json` envelope documents in `docs/cli.md`. The human message doubles as the
 * text content. Structured content must be an object, so operations whose CLI data is an array
 * wrap it under a named key before reaching here.
 */
export function toolResult(
  result: OperationResult<Record<string, unknown>>,
): CallToolResult {
  return {
    content: [{ type: "text", text: result.message }],
    structuredContent: machineValue(result.data) as Record<string, unknown>,
  };
}

/** Run an MCP-native result builder while preserving the shared domain-error mapping. */
export async function runMcpTool(
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return toolErrorResult(error);
  }
}

/** Run an operation, mapping any thrown domain error to an error tool result. */
export async function runTool(
  operation: () => Promise<OperationResult<Record<string, unknown>>>,
): Promise<CallToolResult> {
  return runMcpTool(async () => toolResult(await operation()));
}
