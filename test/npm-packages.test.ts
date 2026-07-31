import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  NPM_LAUNCHER,
  NPM_PLATFORM_PACKAGES,
  npmPackageExecutableNames,
  npmPlatformManifest,
  npmRootManifest,
} from "../scripts/npm-packages.ts";
import { assertOwnedPackage } from "../scripts/publish-npm.ts";
import { archiveName, RELEASE_TARGETS } from "../scripts/release-config.ts";

async function command(command: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("npm release packages", () => {
  test("covers every supported release target", () => {
    expect(Object.keys(NPM_PLATFORM_PACKAGES).sort()).toEqual(
      Object.keys(RELEASE_TARGETS).sort(),
    );
  });

  test("pins every optional platform package to the product version", () => {
    const manifest = npmRootManifest("1.2.3");

    expect("private" in manifest).toBe(false);
    expect(manifest.bin).toEqual({ spotuify: "bin/spotuify.cjs" });
    expect(manifest.optionalDependencies).toEqual({
      "spotuify-darwin-arm64": "1.2.3",
      "spotuify-linux-arm64": "1.2.3",
      "spotuify-linux-x64": "1.2.3",
      "spotuify-windows-x64": "1.2.3",
    });
  });

  test("uses npm platform selectors and Windows executable names", () => {
    const windows = RELEASE_TARGETS["windows-x64"];
    const linux = RELEASE_TARGETS["linux-x64"];

    expect(npmPlatformManifest("1.2.3", windows)).toMatchObject({
      name: "spotuify-windows-x64",
      os: ["win32"],
      cpu: ["x64"],
    });
    expect(npmPlatformManifest("1.2.3", linux)).toMatchObject({
      name: "spotuify-linux-x64",
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    });
    expect(npmPackageExecutableNames(windows)).toEqual([
      "spotuify.exe",
      "spotuify-engine.exe",
    ]);
    expect(archiveName("1.2.3", windows)).toBe("spotuify-v1.2.3-windows-x64.zip");
  });

  test("refuses to publish over an npm package from another repository", () => {
    expect(() =>
      assertOwnedPackage("spotuify", {
        repository: {
          url: "https://github.com/example/not-spotuify.git",
        },
      }),
    ).toThrow("already exists");
    expect(() =>
      assertOwnedPackage("spotuify", {
        repository: {
          url: "git+https://github.com/austin-smith/spotuify.git",
        },
      }),
    ).not.toThrow();
  });

  test("launcher delegates arguments to the installed platform binary", async () => {
    const target = Object.values(RELEASE_TARGETS).find(
      ({ platform, arch }) => platform === process.platform && arch === process.arch,
    );
    expect(target).toBeDefined();
    if (target === undefined) return;

    const temporary = await mkdtemp(resolve(tmpdir(), "spotuify-npm-launcher-"));
    const rootPackage = resolve(temporary, "node_modules", "spotuify");
    const platformPackage = NPM_PLATFORM_PACKAGES[target.id];
    const platformRoot = resolve(temporary, "node_modules", platformPackage.name);
    const launcher = resolve(rootPackage, "bin", "spotuify.cjs");
    const executable = resolve(platformRoot, "bin", "spotuify");

    try {
      await mkdir(resolve(rootPackage, "bin"), { recursive: true });
      await mkdir(resolve(platformRoot, "bin"), { recursive: true });
      await copyFile(NPM_LAUNCHER, launcher);
      await Bun.write(
        resolve(platformRoot, "package.json"),
        `${JSON.stringify({ name: platformPackage.name, version: "1.2.3" })}\n`,
      );
      await Bun.write(
        executable,
        [
          "#!/usr/bin/env node",
          "console.log(JSON.stringify(process.argv.slice(2)));",
          "",
        ].join("\n"),
      );
      await chmod(executable, 0o755);

      const result = await command(["node", launcher, "--flag", "two words"]);
      expect(result).toEqual({
        exitCode: 0,
        stdout: '["--flag","two words"]',
        stderr: "",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
