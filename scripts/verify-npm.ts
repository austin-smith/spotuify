import { chmod, cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import {
  assertNativeHost,
  productVersion,
  RELEASE_TARGETS,
  releaseTarget,
  type ReleaseTarget,
} from "./release-config.ts";
import {
  NPM_DIST_DIR,
  NPM_PACKAGE_NAMES,
  NPM_ROOT_PACKAGE,
  npmPackageExecutableNames,
  npmPackageTarballName,
  npmPlatformManifest,
  npmPlatformPackage,
  npmRootManifest,
} from "./npm-packages.ts";
import { softwareLicenses } from "../src/licenses.ts";

async function output(command: string[]): Promise<string> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
  return stdout.trim();
}

async function packageFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

async function extractPackage(name: string, version: string): Promise<{
  packageRoot: string;
  temporary: string;
}> {
  const tarball = resolve(NPM_DIST_DIR, npmPackageTarballName(name, version));
  const metadata = await stat(tarball);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`${tarball} is empty`);

  const temporary = await mkdtemp(resolve(tmpdir(), "spotuify-npm-"));
  const process = Bun.spawn(["tar", "-xzf", tarball, "-C", temporary], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await process.exited) !== 0) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(`could not extract ${tarball}`);
  }
  return { packageRoot: resolve(temporary, "package"), temporary };
}

async function verifyManifest(packageRoot: string, expected: object): Promise<void> {
  const actual = await Bun.file(resolve(packageRoot, "package.json")).json();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `unexpected npm manifest for ${String((expected as { name?: unknown }).name)}`,
    );
  }
}

async function verifyRootPackage(version: string): Promise<void> {
  const { packageRoot, temporary } = await extractPackage(NPM_ROOT_PACKAGE, version);
  try {
    const expectedFiles = ["bin/spotuify.cjs", "package.json"];
    const actualFiles = await packageFiles(packageRoot);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`unexpected ${NPM_ROOT_PACKAGE} files: ${actualFiles.join(", ")}`);
    }
    await verifyManifest(packageRoot, npmRootManifest(version));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyPlatformPackage(
  version: string,
  target: ReleaseTarget,
  execute: boolean,
): Promise<void> {
  const packageMetadata = npmPlatformPackage(target);
  const { packageRoot, temporary } = await extractPackage(packageMetadata.name, version);
  try {
    const [mainExecutable, engineExecutable] = npmPackageExecutableNames(target);
    const expectedFiles = [
      `bin/${mainExecutable}`,
      `bin/${engineExecutable}`,
      "package.json",
    ].sort();
    const actualFiles = await packageFiles(packageRoot);
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`unexpected ${packageMetadata.name} files: ${actualFiles.join(", ")}`);
    }
    await verifyManifest(packageRoot, npmPlatformManifest(version, target));

    if (execute) {
      assertNativeHost(target);
      const expectedLicenses = (await softwareLicenses()).trim();
      const executable = resolve(packageRoot, "bin", mainExecutable);
      const engine = resolve(packageRoot, "bin", engineExecutable);
      if (target.platform !== "win32") {
        await chmod(executable, 0o755);
        await chmod(engine, 0o755);
      }
      const [mainVersion, engineVersion, licenses] = await Promise.all([
        output([executable, "--version"]),
        output([engine, "--version"]),
        output([executable, "licenses"]),
      ]);
      if (mainVersion !== `spotuify ${version}`) {
        throw new Error(`npm main executable reported ${JSON.stringify(mainVersion)}`);
      }
      if (engineVersion !== `spotuify-engine ${version}`) {
        throw new Error(`npm engine executable reported ${JSON.stringify(engineVersion)}`);
      }
      if (licenses !== expectedLicenses) {
        throw new Error("npm main executable reported unexpected software licenses");
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyInstalledLauncher(version: string, target: ReleaseTarget): Promise<void> {
  assertNativeHost(target);
  const expectedLicenses = (await softwareLicenses()).trim();
  const root = await extractPackage(NPM_ROOT_PACKAGE, version);
  const platformPackage = npmPlatformPackage(target);
  const platform = await extractPackage(platformPackage.name, version);
  const temporary = await mkdtemp(resolve(tmpdir(), "spotuify-npm-install-"));
  const nodeModules = resolve(temporary, "node_modules");

  try {
    await mkdir(nodeModules, { recursive: true });
    const installedRoot = resolve(nodeModules, NPM_ROOT_PACKAGE);
    await cp(root.packageRoot, installedRoot, { recursive: true });
    await cp(platform.packageRoot, resolve(nodeModules, platformPackage.name), {
      recursive: true,
    });
    const launcher = resolve(installedRoot, "bin", "spotuify.cjs");
    const [launcherVersion, licenses] = await Promise.all([
      output(["node", launcher, "--version"]),
      output(["node", launcher, "licenses"]),
    ]);
    if (launcherVersion !== `spotuify ${version}`) {
      throw new Error(`npm launcher reported ${JSON.stringify(launcherVersion)}`);
    }
    if (licenses !== expectedLicenses) {
      throw new Error("npm launcher reported unexpected software licenses");
    }
  } finally {
    await Promise.all([
      rm(root.temporary, { recursive: true, force: true }),
      rm(platform.temporary, { recursive: true, force: true }),
      rm(temporary, { recursive: true, force: true }),
    ]);
  }
}

const argument = process.argv[2];
const version = await productVersion();
if (argument === "root") {
  await verifyRootPackage(version);
} else if (argument === "install") {
  await verifyInstalledLauncher(version, releaseTarget(process.argv[3]));
} else if (argument === "all") {
  const expectedTarballs = NPM_PACKAGE_NAMES.map((name) =>
    npmPackageTarballName(name, version),
  ).sort();
  const actualTarballs = (await readdir(NPM_DIST_DIR))
    .filter((file) => file.endsWith(".tgz"))
    .sort();
  if (JSON.stringify(actualTarballs) !== JSON.stringify(expectedTarballs)) {
    throw new Error(
      `expected npm packages ${expectedTarballs.join(", ")}, ` +
        `found ${actualTarballs.join(", ") || "none"}`,
    );
  }
  await verifyRootPackage(version);
  for (const target of Object.values(RELEASE_TARGETS)) {
    await verifyPlatformPackage(version, target, false);
  }
} else {
  await verifyPlatformPackage(version, releaseTarget(argument), true);
}

console.log(`verified npm package set for ${argument}`);
