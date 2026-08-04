import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("spotuify mcp serves the protocol over stdio with a clean stderr", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-mcp-stdio-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
      SPOTUIFY_RUNTIME_DIR: join(directory, "runtime"),
      SPOTUIFY_NO_UPDATE_CHECK: "1",
    },
    stderr: "pipe",
  });
  let stderrText = "";
  const client = new Client({ name: "spotuify-stdio-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    // A successful initialize handshake is itself the stdout-purity check: any stray write
    // would corrupt the JSON-RPC stream and fail the connection.
    expect(client.getServerVersion()).toMatchObject({
      name: "spotuify",
      version: VERSION,
    });

    const { tools } = await client.listTools();
    expect(tools.length).toBe(18);
    expect(tools.map((tool) => tool.name)).toContain("playback_status");

    // Unauthenticated tool calls answer with a tool error instead of hanging or crashing.
    const result = await client.callTool({ name: "queue_list", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain("spotuify auth");
  } finally {
    await client.close();
  }

  // Diagnostics stay on stderr and never carry protocol frames.
  expect(stderrText).not.toContain('"jsonrpc"');

  // The stdio server must leave no application state behind.
  expect(
    await Bun.file(join(directory, "config", "spotuify", "token.json")).exists(),
  ).toBe(false);
  expect(
    await Bun.file(join(directory, "cache", "spotuify", "update.json")).exists(),
  ).toBe(false);
}, 15_000);

test("closing stdin shuts the server down without signals", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-mcp-eof-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "mcp"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
      SPOTUIFY_RUNTIME_DIR: join(directory, "runtime"),
      SPOTUIFY_NO_UPDATE_CHECK: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killTimer = setTimeout(() => child.kill(), 10_000);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "eof-test", version: "0.0.0" },
      },
    })}\n`,
  );
  await child.stdin.flush();

  // Wait for the initialize response before closing stdin, like a real client.
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  while (!stdout.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    stdout += decoder.decode(value);
  }
  expect(stdout).toContain('"serverInfo"');

  // The MCP stdio shutdown sequence: the client closes stdin and the server exits on its own.
  await child.stdin.end();
  const exitCode = await child.exited;
  clearTimeout(killTimer);
  expect(exitCode).toBe(0);
}, 15_000);
