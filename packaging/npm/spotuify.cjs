#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { dirname, join } = require("node:path");

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
  const result = spawnSync(executable, process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: false,
  });

  if (result.error !== undefined) {
    fail(`could not launch ${executable}: ${result.error.message}`);
    return;
  }
  if (result.signal !== null) {
    if (process.platform === "win32") {
      process.exitCode = 1;
    } else {
      process.kill(process.pid, result.signal);
    }
    return;
  }
  process.exitCode = result.status ?? 1;
}

main();
