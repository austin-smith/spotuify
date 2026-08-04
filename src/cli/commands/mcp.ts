import { Command } from "commander";
import { ExitCode, usageError } from "../errors.ts";
import type { CliIo, GlobalOutputOptions } from "../output.ts";
import type { RunState } from "../support.ts";

export function registerMcp(
  program: Command,
  io: CliIo,
  state: RunState,
): void {
  program
    .command("mcp")
    .description("Run the Model Context Protocol server on stdio")
    .action(async (_options, command: Command) => {
      const globals = command.optsWithGlobals() as GlobalOutputOptions;
      if (
        globals.output !== undefined ||
        globals.json === true ||
        globals.plain === true ||
        globals.quiet === true ||
        globals.field !== undefined ||
        globals.template !== undefined
      ) {
        throw usageError(
          "Output options do not apply to the MCP server.",
          "The MCP protocol owns stdout; run `spotuify mcp` without output flags.",
        );
      }
      const { runMcpServer } = await import("../../mcp/server.ts");
      const { interrupted } = await runMcpServer(io);
      if (interrupted) state.exitCode = ExitCode.interrupted;
    });
}
