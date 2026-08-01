import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliSession } from "../src/cli/session.ts";
import type { TokenStore } from "../src/auth/tokens.ts";

const realFetch = globalThis.fetch;
let directory: string | undefined;
afterEach(async () => {
  globalThis.fetch = realFetch;
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("direct CLI session", () => {
  test("does not spend a profile request on playback-only commands", async () => {
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      paths.push(path);
      if (path === "/me") {
        return Response.json({
          id: "user",
          display_name: "Listener",
          product: "premium",
          country: "US",
        });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const tokens = {
      accessToken: async () => "token",
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
      authorizationId: async () => "authorization",
    } as unknown as TokenStore;

    directory = await mkdtemp(join(tmpdir(), "spotuify-cli-session-test-"));
    const session = await createCliSession(tokens, {
      profilePath: join(directory, "profile.json"),
    });
    expect(paths).toEqual([]);
    await session.player.pause();
    expect(paths).toEqual(["/me/player/pause"]);
    expect((await session.profile()).id).toBe("user");
    expect(paths).toEqual(["/me/player/pause", "/me"]);
    await session.profile();
    expect(paths).toEqual(["/me/player/pause", "/me"]);
  });
});
