import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReauthRequiredError } from "../src/auth/tokens.ts";
import type { TokenStore } from "../src/auth/tokens.ts";
import {
  createCliSession,
  primeCliSessionForTests,
  resetCliSessionForTests,
} from "../src/cli/session.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { VERSION } from "../src/version.ts";

const EXPECTED_TOOLS = [
  "add_playlist_items",
  "get_lyrics",
  "get_resource",
  "list_devices",
  "list_playlists",
  "pause",
  "play",
  "playback_status",
  "queue_add",
  "queue_list",
  "remove_from_library",
  "save_to_library",
  "search",
  "seek",
  "set_playback_mode",
  "set_volume",
  "skip",
  "transfer_playback",
];

const realFetch = globalThis.fetch;
const realRuntimeDir = process.env["SPOTUIFY_RUNTIME_DIR"];

let client: Client | undefined;
let directories: string[] = [];

async function connectedClient(): Promise<Client> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "spotuify-tests", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** Point the default control paths at an empty directory: no runtime is reachable. */
async function withoutRuntime(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "spotuify-mcp-runtime-"));
  directories.push(directory);
  process.env["SPOTUIFY_RUNTIME_DIR"] = directory;
}

async function primeSession(
  tokens: TokenStore,
  respond: (path: string) => Response,
): Promise<string[]> {
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace("/v1", "");
    paths.push(path);
    return respond(path);
  }) as unknown as typeof fetch;
  const directory = await mkdtemp(join(tmpdir(), "spotuify-mcp-session-"));
  directories.push(directory);
  primeCliSessionForTests(
    await createCliSession(tokens, {
      profilePath: join(directory, "profile.json"),
    }),
  );
  return paths;
}

function workingTokens(): TokenStore {
  return {
    accessToken: async () => "token",
    refresh: async () => {
      throw new Error("unexpected refresh");
    },
    authorizationId: async () => "authorization",
  } as unknown as TokenStore;
}

function expiredTokens(): TokenStore {
  return {
    accessToken: async () => {
      throw new ReauthRequiredError("The Spotify login has expired.");
    },
    refresh: async () => {
      throw new Error("unexpected refresh");
    },
    authorizationId: async () => "authorization",
  } as unknown as TokenStore;
}

beforeEach(() => {
  resetCliSessionForTests();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (realRuntimeDir === undefined) delete process.env["SPOTUIFY_RUNTIME_DIR"];
  else process.env["SPOTUIFY_RUNTIME_DIR"] = realRuntimeDir;
  resetCliSessionForTests();
  await client?.close();
  client = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("mcp server surface", () => {
  test("advertises the server identity and instructions", async () => {
    const connected = await connectedClient();
    expect(connected.getServerVersion()).toMatchObject({
      name: "spotuify",
      version: VERSION,
    });
    expect(connected.getInstructions()).toContain("spotuify auth");
  });

  test("lists the complete curated tool set", async () => {
    const connected = await connectedClient();
    const { tools } = await connected.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  test("annotates reads, mutations, and the one destructive tool", async () => {
    const connected = await connectedClient();
    const { tools } = await connected.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("playback_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName.get("search")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(byName.get("play")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName.get("remove_from_library")?.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  test("declares output schemas only for the stable read shapes", async () => {
    const connected = await connectedClient();
    const { tools } = await connected.listTools();
    const withOutput = tools
      .filter((tool) => tool.outputSchema !== undefined)
      .map((tool) => tool.name)
      .sort();
    expect(withOutput).toEqual([
      "list_devices",
      "list_playlists",
      "playback_status",
      "queue_list",
    ]);
  });
});

describe("mcp tool calls", () => {
  test("playback_status returns the CLI's snake_case machine shape", async () => {
    await withoutRuntime();
    const paths = await primeSession(
      workingTokens(),
      () => new Response(null, { status: 204 }),
    );
    const connected = await connectedClient();
    const result = await connected.callTool({
      name: "playback_status",
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      active: false,
      is_playing: false,
      item: null,
      progress_ms: null,
      duration_ms: null,
      shuffle: false,
      repeat: "off",
      context_uri: null,
      device: null,
    });
    expect(result.content).toEqual([
      { type: "text", text: "Nothing is playing." },
    ]);
    expect(paths).toEqual(["/me/player"]);
  });

  test("a mutation reports the routed result", async () => {
    await withoutRuntime();
    const paths = await primeSession(
      workingTokens(),
      () => new Response(null, { status: 204 }),
    );
    const connected = await connectedClient();
    const result = await connected.callTool({ name: "pause", arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ device_id: null });
    expect(paths).toEqual(["/me/player/pause"]);
  });

  test("missing credentials become a tool error with the auth hint", async () => {
    await withoutRuntime();
    await primeSession(
      expiredTokens(),
      () => new Response(null, { status: 204 }),
    );
    const connected = await connectedClient();
    const result = await connected.callTool({ name: "pause", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain("Run `spotuify auth`");
    // Error results are text-only: structured content would fail client-side output
    // schema validation on tools that declare one.
    expect(result.structuredContent).toBeUndefined();
  });

  test("domain validation failures are tool errors, not protocol errors", async () => {
    await withoutRuntime();
    const connected = await connectedClient();
    const result = await connected.callTool({
      name: "queue_add",
      arguments: { uris: ["spotify:album:abc123"] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain("Only tracks and episodes");
  });

  test("schema-invalid arguments are rejected before the handler runs", async () => {
    const connected = await connectedClient();
    const result = await connected.callTool({
      name: "seek",
      arguments: { position_ms: -5 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toContain("Input validation error");
  });
});
