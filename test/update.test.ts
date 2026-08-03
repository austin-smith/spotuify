import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSource } from "../src/distribution.ts";
import { compareSemanticVersions } from "../src/semver.ts";
import {
  automaticUpdateChecksEnabled,
  checkForUpdate,
  markUpdateNotified,
  updateChannel,
} from "../src/update.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function cachePath(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "spotuify-update-test-"));
  return join(directory, "update.json");
}

function npmMetadata(version: string, etag: string | null = '"npm-etag"'): Response {
  return new Response(JSON.stringify({ version }), {
    headers: etag === null ? undefined : { etag },
  });
}

describe("update source and version policy", () => {
  test("uses explicit distribution metadata instead of path heuristics", () => {
    expect(installSource("npm", true)).toBe("npm");
    expect(installSource("homebrew", true)).toBe("homebrew");
    expect(installSource(undefined, true)).toBe("direct");
    expect(installSource(undefined, false)).toBe("source");
    expect(installSource("untrusted-value", true)).toBe("direct");
  });

  test("preserves npm canary users and compares complete SemVer precedence", () => {
    expect(updateChannel("1.2.3")).toBe("latest");
    expect(updateChannel("1.2.3-canary.20260731.42")).toBe("canary");
    expect(compareSemanticVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemanticVersions("1.0.0", "1.0.0-canary.42")).toBe(1);
  });

  test("honors both product-specific and conventional passive-check opt-outs", () => {
    expect(automaticUpdateChecksEnabled({})).toBe(true);
    expect(automaticUpdateChecksEnabled({ SPOTUIFY_NO_UPDATE_CHECK: "1" })).toBe(false);
    expect(automaticUpdateChecksEnabled({ NO_UPDATE_NOTIFIER: "1" })).toBe(false);
    expect(automaticUpdateChecksEnabled({ CI: "true" })).toBe(false);
  });
});

describe("cached update checks", () => {
  test("reads npm's requested dist-tag and caches a private notification record", async () => {
    const path = await cachePath();
    let request: { url: string; init?: RequestInit } | undefined;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return npmMetadata("1.1.0");
    };

    const result = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher,
      now: 1_000,
      source: "npm",
    });

    expect(result).toMatchObject({
      status: "available",
      latestVersion: "1.1.0",
      channel: "latest",
      command: "npm install --global spotuify@latest",
      shouldNotify: true,
      stale: false,
    });
    expect(request?.url).toBe("https://registry.npmjs.org/spotuify/latest");
    expect(new Headers(request?.init?.headers).get("accept")).toBe("application/json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    if (result.status !== "available") throw new Error("expected an update");
    await markUpdateNotified(result, path);
    const cached = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => {
        throw new Error("fresh cache should avoid the network");
      },
      now: 1_001,
      source: "npm",
    });
    expect(cached).toMatchObject({ status: "available", shouldNotify: false });
  });

  test("selects canary metadata for an installed canary", async () => {
    const result = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.2.0-canary.20260731.41",
      env: {},
      fetcher: async (input) => {
        expect(String(input)).toBe("https://registry.npmjs.org/spotuify/canary");
        return npmMetadata("1.2.0-canary.20260731.42");
      },
      now: 1_000,
      source: "npm",
    });
    expect(result).toMatchObject({
      status: "available",
      channel: "canary",
      latestVersion: "1.2.0-canary.20260731.42",
      command: "npm install --global spotuify@canary",
    });
  });

  test("uses published tap metadata as the installable Homebrew version", async () => {
    let requested = "";
    const result = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.2.2",
      env: {},
      fetcher: async (input) => {
        requested = String(input);
        return new Response('{"schema":1,"version":"1.2.3"}\n');
      },
      now: 1_000,
      source: "homebrew",
    });
    expect(requested).toContain("homebrew-tap/main/metadata/spotuify.json");
    expect(result).toMatchObject({
      status: "available",
      latestVersion: "1.2.3",
      command: "brew update && brew upgrade austin-smith/tap/spotuify",
    });
  });

  test("uses the latest release manifest for standalone updates", async () => {
    const main = "a".repeat(64);
    const engine = "b".repeat(64);
    const target = process.platform === "darwin"
      ? "darwin-arm64"
      : process.platform === "win32"
        ? "windows-x64"
        : process.arch === "arm64"
          ? "linux-arm64"
          : "linux-x64";
    const extension = process.platform === "win32" ? ".exe" : "";
    let requested = "";
    const result = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.2.2",
      env: {},
      fetcher: async (input) => {
        requested = String(input);
        return new Response(
          `${engine}  spotuify-v1.2.3-${target}-standalone-engine${extension}\n` +
            `${main}  spotuify-v1.2.3-${target}-standalone-spotuify${extension}\n` +
            (process.platform === "win32"
              ? `${"c".repeat(64)}  spotuify-v1.2.3-${target}-standalone-launcher.exe\n`
              : ""),
        );
      },
      now: 1_000,
      source: "standalone",
      standaloneTarget: target,
    });
    expect(requested).toContain("releases/latest/download/SHA256SUMS");
    expect(result).toMatchObject({
      status: "available",
      source: "standalone",
      latestVersion: "1.2.3",
      command: "spotuify update",
    });
  });

  test("revalidates stale metadata with ETags", async () => {
    const path = await cachePath();
    await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.1.0"),
      now: 1_000,
      source: "npm",
    });

    const ifNoneMatch: Array<string | null> = [];
    const result = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async (_input, init) => {
        ifNoneMatch.push(new Headers(init?.headers).get("if-none-match"));
        return new Response(null, { status: 304 });
      },
      force: true,
      now: 2_000,
      source: "npm",
    });
    expect(ifNoneMatch).toEqual(['"npm-etag"']);
    expect(result).toMatchObject({ status: "available", latestVersion: "1.1.0" });
  });

  test("clears an old validator when fresh metadata has no ETag", async () => {
    const path = await cachePath();
    await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.1.0"),
      now: 1_000,
      source: "npm",
    });
    await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.2.0", null),
      force: true,
      now: 2_000,
      source: "npm",
    });

    let validator: string | null = "not requested";
    await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async (_input, init) => {
        validator = new Headers(init?.headers).get("if-none-match");
        return npmMetadata("1.3.0");
      },
      force: true,
      now: 3_000,
      source: "npm",
    });
    expect(validator).toBeNull();
  });

  test("recovers from a clock rollback and a corrupt cache", async () => {
    const path = await cachePath();
    await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.1.0"),
      now: 2_000,
      source: "npm",
    });

    let requests = 0;
    const afterRollback = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => {
        requests++;
        return npmMetadata("1.2.0");
      },
      now: 1_000,
      source: "npm",
    });
    expect(requests).toBe(1);
    expect(afterRollback).toMatchObject({
      status: "available",
      latestVersion: "1.2.0",
    });

    await Bun.write(path, "not json\n");
    const afterCorruption = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.3.0"),
      now: 3_000,
      source: "npm",
    });
    expect(afterCorruption).toMatchObject({
      status: "available",
      latestVersion: "1.3.0",
    });
  });

  test("cancels a passive request when the caller stops it", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.0.0",
      env: {},
      fetcher: async (_input, init) => {
        expect(init?.signal?.aborted).toBe(true);
        throw new DOMException("aborted", "AbortError");
      },
      signal: controller.signal,
      source: "npm",
    });
    expect(result).toEqual({
      status: "unavailable",
      source: "npm",
      message: "update check was canceled",
    });
  });

  test("keeps a recent cached result during a transient failure and backs off", async () => {
    const path = await cachePath();
    await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.1.0"),
      now: 1_000,
      source: "npm",
    });
    let requests = 0;
    const failing = async () => {
      requests++;
      throw new Error("offline");
    };
    const stale = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: failing,
      now: 25 * 60 * 60 * 1_000,
      source: "npm",
    });
    const backedOff = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: failing,
      now: 25 * 60 * 60 * 1_000 + 1,
      source: "npm",
    });
    expect(stale).toMatchObject({ status: "available", stale: true });
    expect(backedOff).toMatchObject({ status: "available", stale: true });
    expect(requests).toBe(1);
  });

  test("backs off for the full daily interval after an initial failure", async () => {
    const path = await cachePath();
    let requests = 0;
    const failing = async () => {
      requests++;
      throw new Error("offline");
    };
    const first = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: failing,
      now: 1_000,
      source: "npm",
    });
    const backedOff = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: failing,
      now: 24 * 60 * 60 * 1_000 - 1,
      source: "npm",
    });
    expect(first).toMatchObject({ status: "unavailable", message: "offline" });
    expect(backedOff).toMatchObject({
      status: "unavailable",
      message: "update status is temporarily unavailable",
    });
    expect(requests).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("treats rollbacks and opt-outs without false updates", async () => {
    const ahead = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "2.0.0",
      env: {},
      fetcher: async () => npmMetadata("1.9.0"),
      now: 1_000,
      source: "npm",
    });
    expect(ahead).toMatchObject({ status: "current", ahead: true });

    await rm(directory!, { recursive: true, force: true });
    directory = undefined;
    const missingChannel = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.0.0-canary.1",
      env: {},
      fetcher: async () => new Response("not found", { status: 404 }),
      now: 1_000,
      source: "npm",
    });
    expect(missingChannel).toMatchObject({ status: "current", latestVersion: null });

    await rm(directory!, { recursive: true, force: true });
    directory = undefined;
    const missing = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => new Response("not found", { status: 404 }),
      now: 1_000,
      source: "homebrew",
    });
    expect(missing).toMatchObject({
      status: "unavailable",
      message: "update server returned 404",
    });

    let fetched = false;
    const disabled = await checkForUpdate({
      cachePath: await cachePath(),
      currentVersion: "1.0.0",
      env: { SPOTUIFY_NO_UPDATE_CHECK: "1" },
      fetcher: async () => {
        fetched = true;
        return npmMetadata("1.1.0");
      },
      source: "npm",
    });
    expect(disabled).toEqual({ status: "disabled" });
    expect(fetched).toBe(false);
  });

  test("rejects malformed and oversized remote metadata without corrupting the cache", async () => {
    const path = await cachePath();
    const malformed = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () => new Response('{"version":"not semver"}'),
      force: true,
      source: "npm",
    });
    expect(malformed).toMatchObject({ status: "unavailable" });

    const oversized = await checkForUpdate({
      cachePath: path,
      currentVersion: "1.0.0",
      env: {},
      fetcher: async () =>
        new Response("small", { headers: { "content-length": "65537" } }),
      force: true,
      source: "npm",
    });
    expect(oversized).toMatchObject({
      status: "unavailable",
      message: "update metadata response is too large",
    });
    expect(await readFile(path, "utf8").catch(() => "")).not.toContain("not semver");
  });
});
