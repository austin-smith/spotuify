#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { realpathSync, statSync } = require("node:fs");
const { dirname, join, posix, win32 } = require("node:path");

// Shared by the compiled CLI and this launcher. It lets the native process finish before npm
// replaces its executable, which is required on Windows and harmless everywhere else.
const UPDATE_AVAILABLE_EXIT_CODE = 10;

const platformPackages = {
  "darwin-arm64": "spotuify-darwin-arm64",
  "linux-arm64": "spotuify-linux-arm64",
  "linux-x64": "spotuify-linux-x64",
  "win32-x64": "spotuify-windows-x64",
};

function fail(message) {
  console.error(`spotuify: ${message}`);
  process.exitCode = 1;
}

function forwardResult(result, executable) {
  if (result.error !== undefined) {
    fail(`could not launch ${executable}: ${result.error.message}`);
    return false;
  }
  if (result.signal !== null) {
    if (process.platform === "win32") {
      process.exitCode = 1;
    } else {
      process.kill(process.pid, result.signal);
    }
    return false;
  }
  process.exitCode = result.status ?? 1;
  return result.status === 0;
}

function environmentValue(environment, name) {
  const match = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === name.toUpperCase(),
  );
  return match?.[1];
}

function resolveWindowsNpmLauncher(
  environment = process.env,
  nodeExecutable = process.execPath,
  currentDirectory = process.cwd(),
  isFile = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
) {
  const workingDirectory = win32.resolve(currentDirectory).toLowerCase();
  const pathDirectories = (environmentValue(environment, "PATH") || "").split(
    win32.delimiter,
  );
  const visited = new Set();
  const trustedDirectories = [];
  const addDirectory = (rawDirectory, allowWorkingDirectory) => {
    if (!rawDirectory || !win32.isAbsolute(rawDirectory)) return;
    const directory = win32.resolve(rawDirectory);
    const normalized = directory.toLowerCase();
    if ((!allowWorkingDirectory && normalized === workingDirectory) || visited.has(normalized)) {
      return;
    }
    visited.add(normalized);
    trustedDirectories.push(directory);
  };
  // process.execPath is already an absolute, OS-resolved executable path. PATH entries are
  // accepted only when they are absolute and never when they resolve to the working directory.
  addDirectory(win32.dirname(nodeExecutable), true);
  for (const directory of pathDirectories) addDirectory(directory, false);

  for (const directory of trustedDirectories) {
    const executable = win32.join(directory, "npm.exe");
    if (isFile(executable)) return { executable, argsPrefix: [] };
    const npmCli = win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (!isFile(npmCli)) continue;
    const localNode = win32.join(directory, "node.exe");
    const runningNode =
      win32.basename(nodeExecutable).toLowerCase() === "node.exe" && isFile(nodeExecutable)
        ? win32.resolve(nodeExecutable)
        : undefined;
    const node = isFile(localNode) ? localNode : runningNode;
    if (node !== undefined) return { executable: node, argsPrefix: [npmCli] };
  }
  throw new Error("could not find a trusted npm.exe or npm-cli.js runtime");
}

function resolvePosixNpmLauncher(
  nodeExecutable = process.execPath,
  isFile = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath = realpathSync,
) {
  const node = posix.resolve(nodeExecutable);
  const siblingNpm = posix.join(posix.dirname(node), "npm");
  if (isFile(siblingNpm)) {
    const npmCli = realpath(siblingNpm);
    if (isFile(npmCli)) return { executable: node, argsPrefix: [npmCli] };
  }

  const npmCli = posix.resolve(
    posix.dirname(node),
    "../lib/node_modules/npm/bin/npm-cli.js",
  );
  if (isFile(npmCli)) return { executable: node, argsPrefix: [npmCli] };
  throw new Error("could not find npm beside the running Node.js executable");
}

function npmUpdateInvocation(
  channel,
  platform = process.platform,
  npmLauncher = platform === "win32"
    ? resolveWindowsNpmLauncher()
    : resolvePosixNpmLauncher(),
) {
  const args = ["install", "--global", `spotuify@${channel}`];
  if (npmLauncher === undefined) throw new Error("missing npm runtime");
  return {
    executable: npmLauncher.executable,
    args: [...npmLauncher.argsPrefix, ...args],
  };
}

function npmChildEnvironment(environment = process.env) {
  const childEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() !== "SPOTUIFY_INSTALL_SOURCE") childEnvironment[key] = value;
  }
  childEnvironment.SPOTUIFY_INSTALL_SOURCE = "npm";
  return childEnvironment;
}

function main() {
  const platform = `${process.platform}-${process.arch}`;
  if (
    process.platform === "linux" &&
    process.report?.getReport().header.glibcVersionRuntime === undefined
  ) {
    fail(`unsupported platform ${platform}; the Linux build requires glibc`);
    return;
  }
  const platformPackage = platformPackages[platform];
  if (platformPackage === undefined) {
    fail(`unsupported platform ${platform}`);
    return;
  }

  let packageRoot;
  try {
    packageRoot = dirname(require.resolve(`${platformPackage}/package.json`));
  } catch {
    fail(
      `the ${platformPackage} binary package is missing; reinstall without omitting optional dependencies`,
    );
    return;
  }

  const executable = join(
    packageRoot,
    "bin",
    process.platform === "win32" ? "spotuify.exe" : "spotuify",
  );
  const args = process.argv.slice(2);
  const installingUpdate = args.length === 1 && args[0] === "update";
  const result = spawnSync(executable, installingUpdate ? ["update", "--check"] : args, {
    stdio: "inherit",
    windowsHide: false,
    env: npmChildEnvironment(),
  });

  if (!installingUpdate || result.status !== UPDATE_AVAILABLE_EXIT_CODE) {
    forwardResult(result, executable);
    return;
  }

  const { version } = require("../package.json");
  const channel = String(version).includes("-canary.") ? "canary" : "latest";
  let npm;
  try {
    npm = npmUpdateInvocation(channel);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const update = spawnSync(
    npm.executable,
    npm.args,
    { stdio: "inherit", windowsHide: false },
  );
  if (forwardResult(update, npm.executable)) {
    console.log(`Updated spotuify. Restart spotuify to use it.`);
  }
}

if (require.main === module) main();

module.exports = {
  npmChildEnvironment,
  npmUpdateInvocation,
  resolvePosixNpmLauncher,
  resolveWindowsNpmLauncher,
};
