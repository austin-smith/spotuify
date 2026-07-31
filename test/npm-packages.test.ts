import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import {
  NPM_LAUNCHER,
  NPM_PLATFORM_PACKAGES,
  npmPackageExecutableNames,
  npmPlatformManifest,
  npmRootManifest,
} from "../scripts/npm-packages.ts";
import {
  assertExistingVersionTagged,
  assertOwnedPackage,
  canaryRunNumber,
  isStaleCanary,
  npmDistTag,
} from "../scripts/publish-npm.ts";
import { archiveName, RELEASE_TARGETS } from "../scripts/release-config.ts";

const {
  npmChildEnvironment,
  npmUpdateInvocation,
  resolvePosixNpmLauncher,
  resolveWindowsNpmLauncher,
} = require("../packaging/npm/spotuify.cjs") as {
  npmChildEnvironment: (environment?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  npmUpdateInvocation: (
    channel: "latest" | "canary",
    platform?: NodeJS.Platform,
    npmLauncher?: { executable: string; argsPrefix: string[] },
  ) => { executable: string; args: string[] };
  resolvePosixNpmLauncher: (
    nodeExecutable?: string,
    isFile?: (path: string) => boolean,
    realpath?: (path: string) => string,
  ) => { executable: string; argsPrefix: string[] };
  resolveWindowsNpmLauncher: (
    environment?: NodeJS.ProcessEnv,
    nodeExecutable?: string,
    currentDirectory?: string,
    isFile?: (path: string) => boolean,
  ) => { executable: string; argsPrefix: string[] };
};

async function command(command: string[], env?: NodeJS.ProcessEnv): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(command, {
    env,
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

  test("uses the product description for root and platform packages", () => {
    expect(npmRootManifest("1.2.3").description).toBe("spotify in ur terminal");
    for (const target of Object.values(RELEASE_TARGETS)) {
      expect(npmPlatformManifest("1.2.3", target).description).toBe(
        "spotify in ur terminal",
      );
    }
  });

  test("uses npm platform selectors and Windows release settings", () => {
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
    expect(windows.bunTarget).toBe("bun-windows-x64");
    expect(archiveName("1.2.3", windows)).toBe("spotuify-v1.2.3-windows-x64.zip");
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
    ).toEqual({
      executable: "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
      args: [
        "C:\\Tools (Managed) & Co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
        "--global",
        "spotuify@latest",
      ],
    });
    expect(
      npmChildEnvironment({
        Path: "C:\\Windows",
        spotuify_install_source: "homebrew",
      }),
    ).toEqual({
      Path: "C:\\Windows",
      SPOTUIFY_INSTALL_SOURCE: "npm",
    });
    expect(
      resolveWindowsNpmLauncher(
        { Path: ".;bin;.\\tools;C:\\work\\project;C:\\Secondary" },
        "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
        "C:\\work\\project",
        (path: string) =>
          new Set([
            "c:\\work\\project\\npm.exe",
            "c:\\work\\project\\bin\\npm.exe",
            "c:\\work\\project\\tools\\npm.exe",
            "c:\\tools (managed) & co\\nodejs\\node.exe",
            "c:\\tools (managed) & co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
            "c:\\secondary\\npm.exe",
          ]).has(path.toLowerCase()),
      ),
    ).toEqual({
      executable: "C:\\Tools (Managed) & Co\\nodejs\\node.exe",
      argsPrefix: [
        "C:\\Tools (Managed) & Co\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      ],
    });
    expect(
      resolvePosixNpmLauncher(
        "/opt/node/bin/node",
        (path: string) =>
          path === "/opt/node/bin/npm" ||
          path === "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
        (path: string) =>
          path === "/opt/node/bin/npm"
            ? "/opt/node/lib/node_modules/npm/bin/npm-cli.js"
            : path,
      ),
    ).toEqual({
      executable: "/opt/node/bin/node",
      argsPrefix: ["/opt/node/lib/node_modules/npm/bin/npm-cli.js"],
    });
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

  test("requires an explicit supported npm publication channel", () => {
    expect(npmDistTag(["--tag", "latest"])).toBe("latest");
    expect(npmDistTag(["--tag", "canary"])).toBe("canary");
    expect(() => npmDistTag([])).toThrow("--tag must be one of");
    expect(() => npmDistTag(["--tag", "beta"])).toThrow("--tag must be one of");
  });

  test("refuses a retry when an existing version no longer owns its requested tag", () => {
    expect(() =>
      assertExistingVersionTagged(
        "spotuify",
        {
          "dist-tags": { latest: "1.2.2" },
          versions: { "1.2.3": {} },
        },
        "1.2.3",
        "latest",
      ),
    ).toThrow("refusing to report a successful retry");
    expect(() =>
      assertExistingVersionTagged(
        "spotuify",
        {
          "dist-tags": { latest: "1.2.3" },
          versions: { "1.2.3": {} },
        },
        "1.2.3",
        "latest",
      ),
    ).not.toThrow();
  });

  test("orders canaries by their monotonic workflow run number", () => {
    expect(canaryRunNumber("1.2.3-canary.20260731.42")).toBe(42n);
    expect(canaryRunNumber("2.0.0-canary.20260731.30600831370")).toBe(
      30600831370n,
    );
    expect(canaryRunNumber("1.2.3-canary.41.g0123456789ab")).toBe(41n);
    expect(
      isStaleCanary(
        "1.2.3-canary.41.g0123456789ab",
        "1.2.3-canary.20260731.42",
      ),
    ).toBe(false);
    expect(
      isStaleCanary(
        "1.2.3-canary.20260801.43",
        "1.2.3-canary.20260731.42",
      ),
    ).toBe(true);
    expect(
      isStaleCanary(
        "1.2.3-canary.20260731.42",
        "1.2.3-canary.20260801.43",
      ),
    ).toBe(false);
    expect(() =>
      isStaleCanary(
        "1.2.3-canary.20260731.42",
        "1.2.3-canary.20260801.42",
      ),
    ).toThrow("already associated");
    expect(() => canaryRunNumber("1.2.3")).toThrow("invalid canary version");
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
          "console.log(JSON.stringify({ args: process.argv.slice(2), source: process.env.SPOTUIFY_INSTALL_SOURCE }));",
          "",
        ].join("\n"),
      );
      await chmod(executable, 0o755);

      const result = await command(["node", launcher, "--flag", "two words"]);
      expect(result).toEqual({
        exitCode: 0,
        stdout: '{"args":["--flag","two words"],"source":"npm"}',
        stderr: "",
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test("launcher releases the native executable before installing an npm update", async () => {
    if (process.platform === "win32") return;
    const target = Object.values(RELEASE_TARGETS).find(
      ({ platform, arch }) => platform === process.platform && arch === process.arch,
    );
    expect(target).toBeDefined();
    if (target === undefined) return;

    const temporary = await mkdtemp(resolve(tmpdir(), "spotuify-npm-update-"));
    const rootPackage = resolve(temporary, "node_modules", "spotuify");
    const platformPackage = NPM_PLATFORM_PACKAGES[target.id];
    const platformRoot = resolve(temporary, "node_modules", platformPackage.name);
    const launcher = resolve(rootPackage, "bin", "spotuify.cjs");
    const executable = resolve(platformRoot, "bin", "spotuify");
    const fakeBin = resolve(temporary, "fake-bin");

    try {
      await mkdir(resolve(rootPackage, "bin"), { recursive: true });
      await mkdir(resolve(platformRoot, "bin"), { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await copyFile(NPM_LAUNCHER, launcher);
      await Bun.write(
        resolve(rootPackage, "package.json"),
        `${JSON.stringify({ name: "spotuify", version: "1.2.3-canary.1" })}\n`,
      );
      await Bun.write(
        resolve(platformRoot, "package.json"),
        `${JSON.stringify({ name: platformPackage.name, version: "1.2.3-canary.1" })}\n`,
      );
      await Bun.write(
        executable,
        [
          "#!/usr/bin/env node",
          "console.log(`native ${process.argv.slice(2).join(' ')}`);",
          "process.exitCode = process.argv.slice(2).join(' ') === 'update --check' ? 10 : 2;",
          "",
        ].join("\n"),
      );
      const fakeNpm = resolve(fakeBin, "npm");
      const fakeNode = resolve(fakeBin, "node");
      await Bun.write(
        fakeNpm,
        [
          "#!/usr/bin/env node",
          "console.log(`npm ${process.argv.slice(2).join(' ')}`);",
          "",
        ].join("\n"),
      );
      await copyFile(process.execPath, fakeNode);
      await chmod(executable, 0o755);
      await chmod(fakeNpm, 0o755);
      await chmod(fakeNode, 0o755);

      const result = await command([fakeNode, launcher, "update"], {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("native update --check");
      expect(result.stdout).toContain(
        "npm install --global spotuify@canary",
      );
      expect(result.stdout).toContain("Updated spotuify");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
