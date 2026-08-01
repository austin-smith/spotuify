import { describe, expect, test } from "bun:test";
import {
  npmUpdateInvocation,
  resolvePosixNpmLauncher,
  resolveWindowsNpmLauncher,
  runUpdateCommand,
} from "../src/update-command.ts";
import {
  UPDATE_AVAILABLE_EXIT_CODE,
  type UpdateCheckResult,
} from "../src/update.ts";

function available(
  source: "npm" | "homebrew",
  channel: "latest" | "canary" = "latest",
): UpdateCheckResult {
  return {
    status: "available",
    source,
    channel,
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    command:
      source === "homebrew"
        ? "brew update && brew upgrade austin-smith/tap/spotuify"
        : `npm install --global spotuify@${channel}`,
    shouldNotify: true,
    stale: false,
  };
}

describe("explicit update command", () => {
  test("invokes npm's JavaScript entry point without a Windows shell", () => {
    expect(
      npmUpdateInvocation(
        "latest",
        "win32",
        {
          executable: "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
          argsPrefix: [
            "C:\\Tools (Managed) & Co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
          ],
        },
      ),
    ).toEqual([
      "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
      "C:\\Tools (Managed) & Co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "install",
      "--global",
      "spotuify@latest",
    ]);
    expect(
      npmUpdateInvocation("canary", "linux", {
        executable: "/opt/node/bin/node",
        argsPrefix: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js"],
      }),
    ).toEqual([
      "/opt/node/bin/node",
      "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
      "install",
      "--global",
      "spotuify@canary",
    ]);
  });

  test("resolves POSIX npm through the running Node.js installation, not PATH", () => {
    const npm = "/opt/node/bin/npm";
    const npmCli = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    expect(
      resolvePosixNpmLauncher(
        "/opt/node/bin/node",
        (path) => path === npm || path === npmCli,
        (path) => (path === npm ? npmCli : path),
      ),
    ).toEqual({
      executable: "/opt/node/bin/node",
      argsPrefix: [npmCli],
    });
  });

  test("resolves npm from trusted directories without considering the working directory", () => {
    const existing = new Set([
      "c:\\work\\project\\npm.exe",
      "c:\\work\\project\\bin\\npm.exe",
      "c:\\work\\project\\tools\\npm.exe",
      "c:\\tools (managed) & co\\nodejs\\node.exe",
      "c:\\tools (managed) & co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "c:\\secondary\\npm.exe",
    ]);
    const result = resolveWindowsNpmLauncher(
      { Path: ".;bin;.\\tools;C:\\work\\project;C:\\Secondary" },
      "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
      "C:\\work\\project",
      (path) => existing.has(path.toLowerCase()),
    );
    expect(result).toEqual({
      executable: "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
      argsPrefix: [
        "C:\\Tools (Managed) & Co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      ],
    });
  });

  test("reports an available update without mutating for --check", async () => {
    const output: string[] = [];
    let ran = false;
    const result = await runUpdateCommand({
      check: async () => available("npm"),
      checkOnly: true,
      currentVersion: "1.0.0",
      run: async () => {
        ran = true;
        return 0;
      },
      source: "npm",
      stdout: (message) => output.push(message),
    });
    expect(result).toEqual({
      status: "available",
      exitCode: UPDATE_AVAILABLE_EXIT_CODE,
    });
    expect(ran).toBe(false);
    expect(output.join("\n")).toContain("spotuify update");
  });

  test("updates Homebrew metadata before upgrading the formula", async () => {
    const commands: string[][] = [];
    const result = await runUpdateCommand({
      check: async () => available("homebrew"),
      checkOnly: false,
      currentVersion: "1.0.0",
      run: async (command) => {
        commands.push([...command]);
        return 0;
      },
      source: "homebrew",
      stdout: () => {},
    });
    expect(result).toEqual({ status: "updated", exitCode: 0 });
    expect(commands).toEqual([
      ["brew", "update"],
      ["brew", "upgrade", "austin-smith/tap/spotuify"],
    ]);
  });

  test("preserves the npm canary channel", async () => {
    const commands: string[][] = [];
    const result = await runUpdateCommand({
      check: async () => available("npm", "canary"),
      checkOnly: false,
      currentVersion: "1.0.0-canary.1",
      npmInvocation: (channel) => ["npm", "install", "--global", `spotuify@${channel}`],
      run: async (command) => {
        commands.push([...command]);
        return 0;
      },
      source: "npm",
      stdout: () => {},
    });
    expect(result).toEqual({ status: "updated", exitCode: 0 });
    expect(commands[0]?.slice(1)).toEqual([
      "install",
      "--global",
      "spotuify@canary",
    ]);
  });

  test("does not invoke a manager when current or unavailable", async () => {
    let runs = 0;
    const run = async () => {
      runs++;
      return 0;
    };
    const current = await runUpdateCommand({
      check: async () => ({
        status: "current",
        source: "npm",
        channel: "latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        ahead: false,
      }),
      checkOnly: false,
      currentVersion: "1.0.0",
      run,
      source: "npm",
      stdout: () => {},
    });
    const unavailable = await runUpdateCommand({
      check: async () => ({ status: "unavailable", source: "npm", message: "offline" }),
      checkOnly: false,
      currentVersion: "1.0.0",
      run,
      source: "npm",
      stderr: () => {},
    });
    expect(current).toEqual({ status: "current", exitCode: 0 });
    expect(unavailable).toEqual({ status: "failed", exitCode: 1 });
    expect(runs).toBe(0);
  });

  test("stops when Homebrew metadata refresh fails", async () => {
    const commands: string[][] = [];
    const result = await runUpdateCommand({
      check: async () => available("homebrew"),
      checkOnly: false,
      currentVersion: "1.0.0",
      run: async (command) => {
        commands.push([...command]);
        return 7;
      },
      source: "homebrew",
      stdout: () => {},
    });
    expect(result).toEqual({ status: "failed", exitCode: 7 });
    expect(commands).toEqual([["brew", "update"]]);
  });
});
