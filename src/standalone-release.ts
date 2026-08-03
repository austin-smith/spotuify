import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { StandaloneInstallation, StandaloneTarget } from "./distribution.ts";
import { compareSemanticVersions, isStableVersion } from "./semver.ts";

export const STANDALONE_MANIFEST_URL =
  "https://github.com/austin-smith/spotuify/releases/latest/download/SHA256SUMS";
const RELEASES_URL = "https://github.com/austin-smith/spotuify/releases";
const MAX_COMPONENT_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface StandaloneRelease {
  version: string;
  target: StandaloneTarget;
  main: { name: string; digest: string };
  engine: { name: string; digest: string };
  launcher?: { name: string; digest: string };
}

export interface StandaloneUpdateResult {
  version: string;
  changed: boolean;
}

export type StandaloneFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function componentName(
  version: string,
  target: StandaloneTarget,
  component: "spotuify" | "engine" | "launcher",
): string {
  const extension = target === "windows-x64" ? ".exe" : "";
  return `spotuify-v${version}-${target}-standalone-${component}${extension}`;
}

export function parseStandaloneManifest(
  manifest: string,
  target: StandaloneTarget,
): StandaloneRelease {
  const entries = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    const match = /^([0-9a-fA-F]{64})  (\S+)$/.exec(line);
    if (match === null) continue;
    const digest = match[1]!;
    const name = match[2]!;
    if (entries.has(name)) throw new Error(`release manifest repeats ${name}`);
    entries.set(name, digest.toLowerCase());
  }

  const suffix = `-${target}-standalone-spotuify${target === "windows-x64" ? ".exe" : ""}`;
  const candidates = [...entries.keys()].filter(
    (name) => name.startsWith("spotuify-v") && name.endsWith(suffix),
  );
  if (candidates.length !== 1) {
    throw new Error(`release manifest must contain exactly one standalone ${target} executable`);
  }
  const version = candidates[0]!.slice("spotuify-v".length, -suffix.length);
  if (!isStableVersion(version)) throw new Error("release manifest contains an invalid version");
  const mainName = componentName(version, target, "spotuify");
  const engineName = componentName(version, target, "engine");
  const mainDigest = entries.get(mainName);
  const engineDigest = entries.get(engineName);
  if (mainDigest === undefined || engineDigest === undefined) {
    throw new Error(`release manifest is incomplete for ${target}`);
  }
  const launcherName = target === "windows-x64"
    ? componentName(version, target, "launcher")
    : undefined;
  const launcherDigest = launcherName === undefined ? undefined : entries.get(launcherName);
  if (launcherName !== undefined && launcherDigest === undefined) {
    throw new Error(`release manifest is missing the verified launcher for ${target}`);
  }
  return {
    version,
    target,
    main: { name: mainName, digest: mainDigest },
    engine: { name: engineName, digest: engineDigest },
    ...(launcherName === undefined || launcherDigest === undefined
      ? {}
      : { launcher: { name: launcherName, digest: launcherDigest } }),
  };
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximum) {
    throw new Error("release metadata is unexpectedly large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error("release metadata is unexpectedly large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function writeSynced(path: string, contents: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function writeAllBytes(
  file: {
    write(
      buffer: Uint8Array,
      offset: number,
      length: number,
    ): Promise<{ bytesWritten: number }>;
  },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
      throw new Error("could not write the complete release component");
    }
    offset += result.bytesWritten;
  }
}

async function downloadVerified(
  url: string,
  destination: string,
  digest: string,
  fetcher: StandaloneFetcher,
): Promise<void> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || response.body === null) {
    throw new Error(`download failed with status ${response.status}`);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_COMPONENT_BYTES) {
    throw new Error("release component is unexpectedly large");
  }

  const file = await open(destination, "wx", 0o700);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_COMPONENT_BYTES) {
        await reader.cancel();
        throw new Error("release component is unexpectedly large");
      }
      await writeAllBytes(file, chunk.value);
      hash.update(chunk.value);
    }
    if (length === 0) throw new Error("release component is empty");
    await file.sync();
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (hash.digest("hex") !== digest) {
    throw new Error(`checksum verification failed for ${basename(destination)}`);
  }
}

async function stageWindowsLauncher(root: string, source: string): Promise<void> {
  const bin = join(root, "bin");
  const binMetadata = await lstat(bin);
  if (!binMetadata.isDirectory() || binMetadata.isSymbolicLink()) {
    throw new Error("the managed launcher directory is not a regular directory");
  }
  const active = join(bin, "spotuify.exe");
  const activeMetadata = await lstat(active);
  if (!activeMetadata.isFile() || activeMetadata.isSymbolicLink()) {
    throw new Error("the managed Windows launcher is not a regular file");
  }
  const pending = join(bin, "spotuify.pending.exe");
  const pendingMetadata = await lstat(pending).catch(() => undefined);
  if (
    pendingMetadata !== undefined &&
    (!pendingMetadata.isFile() || pendingMetadata.isSymbolicLink())
  ) {
    throw new Error("the pending Windows launcher is not a regular file");
  }

  const temporary = join(bin, `.spotuify-launcher-${process.pid}-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    const file = await open(temporary, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, pending);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${basename(command[0]!)} failed validation: ${stderr.trim()}`);
  }
  return stdout.replaceAll("\r\n", "\n").trim();
}

async function validateRelease(directory: string, version: string, windows: boolean): Promise<void> {
  const main = join(directory, windows ? "spotuify.exe" : "spotuify");
  const engine = join(directory, windows ? "spotuify-engine.exe" : "spotuify-engine");
  const metadata = await Promise.all([lstat(main), lstat(engine)]);
  if (metadata.some((item) => !item.isFile() || item.isSymbolicLink())) {
    throw new Error("the release contains a non-regular executable");
  }
  const [mainVersion, engineVersion] = await Promise.all([
    capture([main, "--version"]),
    capture([engine, "--version"]),
  ]);
  if (mainVersion !== `spotuify ${version}` || engineVersion !== `spotuify-engine ${version}`) {
    throw new Error("downloaded executables reported an unexpected version");
  }
}

function lockOwner(contents: string | undefined): { pid: number; token: string } | undefined {
  if (contents === undefined) return undefined;
  const [pidText, token] = contents.split("\n");
  if (pidText === undefined || token === undefined || !/^[1-9][0-9]*$/.test(pidText) || token === "") {
    return undefined;
  }
  const pid = Number(pidText);
  return Number.isSafeInteger(pid) ? { pid, token } : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readExistingLockOwner(path: string): Promise<string | undefined> {
  const lock = await lstat(path).catch(() => undefined);
  if (lock === undefined || !lock.isDirectory() || lock.isSymbolicLink()) {
    throw new Error("the Spotuify installation lock is not a regular directory");
  }
  const ownerPath = join(path, "owner");
  const owner = await lstat(ownerPath).catch(() => undefined);
  if (owner === undefined) return undefined;
  if (!owner.isFile() || owner.isSymbolicLink()) {
    throw new Error("the Spotuify installation lock owner is not a regular file");
  }
  return readFile(ownerPath, "utf8");
}

async function acquireLock(root: string): Promise<() => Promise<void>> {
  const path = join(root, ".install.lock");
  const token = `${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path);
      try {
        await writeSynced(join(path, "owner"), `${process.pid}\n${token}\n`);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const owner = await readExistingLockOwner(path).catch(() => undefined);
        if (owner !== undefined && lockOwner(owner)?.token === token) {
          await rm(path, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observedContents = await readExistingLockOwner(path);
      const observed = lockOwner(observedContents);
      if (observed === undefined || processIsAlive(observed.pid) || attempt !== 0) {
        throw new Error("another Spotuify installation is running");
      }

      const reclaim = join(path, "reclaim");
      let claimCreated = false;
      try {
        await mkdir(reclaim);
        claimCreated = true;
        await writeSynced(join(reclaim, "owner"), `${token}\n`);
      } catch (error) {
        if (claimCreated) await rm(reclaim, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("another Spotuify installation is running");
        }
        throw error;
      }

      const confirmedContents = await readExistingLockOwner(path).catch(() => undefined);
      const confirmed = lockOwner(confirmedContents);
      const claimOwner = await readFile(join(reclaim, "owner"), "utf8").catch(() => "");
      if (
        confirmedContents !== observedContents ||
        confirmed === undefined ||
        claimOwner !== `${token}\n` ||
        processIsAlive(confirmed.pid)
      ) {
        if (claimOwner === `${token}\n`) await rm(reclaim, { recursive: true, force: true });
        throw new Error("another Spotuify installation is running");
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("could not acquire the Spotuify installation lock");
}

async function switchCurrent(
  installation: StandaloneInstallation,
  releaseDirectory: string,
): Promise<() => Promise<void>> {
  const current = join(installation.root, "current");
  if (installation.target === "windows-x64") {
    const previous = await readFile(current, "utf8");
    const temporary = `${current}.${process.pid}.${randomUUID()}.tmp`;
    await writeSynced(temporary, `${basename(releaseDirectory)}\n`);
    await rename(temporary, current);
    return async () => {
      const rollback = `${current}.${process.pid}.${randomUUID()}.rollback`;
      await writeSynced(rollback, previous);
      await rename(rollback, current);
    };
  }

  const previous = await readlink(current);
  const temporary = `${current}.${process.pid}.${randomUUID()}.tmp`;
  await symlink(releaseDirectory, temporary);
  await rename(temporary, current);
  return async () => {
    const rollback = `${current}.${process.pid}.${randomUUID()}.rollback`;
    await symlink(previous, rollback);
    await rename(rollback, current);
  };
}

async function activeStandaloneVersion(
  installation: StandaloneInstallation,
): Promise<string> {
  const current = join(installation.root, "current");
  let releaseDirectory: string;
  if (installation.target === "windows-x64") {
    const currentMetadata = await lstat(current);
    if (
      !currentMetadata.isFile() ||
      currentMetadata.isSymbolicLink() ||
      currentMetadata.size > 128
    ) {
      throw new Error("the active release pointer is not a regular file");
    }
    const releaseName = (await readFile(current, "utf8")).trim();
    if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-windows-x64$/.test(releaseName)) {
      throw new Error("the active release pointer is invalid");
    }
    releaseDirectory = join(installation.root, "releases", releaseName);
  } else {
    const currentMetadata = await lstat(current);
    if (!currentMetadata.isSymbolicLink()) {
      throw new Error("the active release pointer is not a symbolic link");
    }
    releaseDirectory = await realpath(current);
    if (dirname(releaseDirectory) !== await realpath(join(installation.root, "releases"))) {
      throw new Error("the active release pointer leaves the managed releases directory");
    }
  }

  const releaseName = basename(releaseDirectory);
  const suffix = `-${installation.target}`;
  if (!releaseName.endsWith(suffix)) throw new Error("the active release target is invalid");
  const version = releaseName.slice(0, -suffix.length);
  if (!isStableVersion(version)) throw new Error("the active release version is invalid");
  const metadata = await lstat(releaseDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("the active release directory is not a regular directory");
  }
  await validateRelease(releaseDirectory, version, installation.target === "windows-x64");
  return version;
}

export async function installStandaloneUpdate(
  installation: StandaloneInstallation,
  expectedVersion: string,
  fetcher: StandaloneFetcher = fetch,
  validateActive: (path: string, version: string) => Promise<void> = async (path, version) => {
    if ((await capture([path, "--version"])) !== `spotuify ${version}`) {
      throw new Error("the active Spotuify command did not switch to the new version");
    }
  },
): Promise<StandaloneUpdateResult> {
  const releaseRoot = join(installation.root, "releases");
  const releaseName = `${expectedVersion}-${installation.target}`;
  const releaseDirectory = join(releaseRoot, releaseName);
  const releaseDownloadUrl = `${RELEASES_URL}/download/v${expectedVersion}`;
  const release = await fetcher(`${releaseDownloadUrl}/SHA256SUMS`, {
    signal: AbortSignal.timeout(10_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`release metadata returned ${response.status}`);
    return parseStandaloneManifest(
      await boundedText(response, MAX_MANIFEST_BYTES),
      installation.target,
    );
  });
  if (release.version !== expectedVersion) {
    throw new Error(`release metadata resolved ${release.version} instead of ${expectedVersion}`);
  }

  const releaseLock = await acquireLock(installation.root);
  const staging = join(releaseRoot, `.staging-${releaseName}-${process.pid}-${randomUUID()}`);
  let committed = false;
  try {
    const releasesMetadata = await lstat(releaseRoot);
    if (!releasesMetadata.isDirectory() || releasesMetadata.isSymbolicLink()) {
      throw new Error("the managed releases path is not a regular directory");
    }
    await mkdir(releaseRoot, { recursive: true });
    const activeVersion = await activeStandaloneVersion(installation);
    if (compareSemanticVersions(activeVersion, expectedVersion) >= 0) {
      return { version: activeVersion, changed: false };
    }
    try {
      const metadata = await lstat(releaseDirectory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`${releaseDirectory} is not a regular directory`);
      }
      await validateRelease(releaseDirectory, expectedVersion, installation.target === "windows-x64");
      if (installation.target === "windows-x64") {
        const launcher = await lstat(join(releaseDirectory, "spotuify-launcher.exe"));
        if (!launcher.isFile() || launcher.isSymbolicLink()) {
          throw new Error("the release contains an invalid Windows launcher");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(staging, { mode: 0o700 });
      const windows = installation.target === "windows-x64";
      const main = join(staging, windows ? "spotuify.exe" : "spotuify");
      const engine = join(staging, windows ? "spotuify-engine.exe" : "spotuify-engine");
      await downloadVerified(`${releaseDownloadUrl}/${release.main.name}`, main, release.main.digest, fetcher);
      await downloadVerified(`${releaseDownloadUrl}/${release.engine.name}`, engine, release.engine.digest, fetcher);
      if (windows) {
        if (release.launcher === undefined) {
          throw new Error("release metadata is missing the Windows launcher");
        }
        await downloadVerified(
          `${releaseDownloadUrl}/${release.launcher.name}`,
          join(staging, "spotuify-launcher.exe"),
          release.launcher.digest,
          fetcher,
        );
      }
      if (!windows) {
        await Promise.all([chmod(main, 0o755), chmod(engine, 0o755), chmod(staging, 0o755)]);
      }
      await validateRelease(staging, expectedVersion, windows);
      await rename(staging, releaseDirectory);
      committed = true;
    }

    const rollback = await switchCurrent(installation, releaseDirectory);
    try {
      const active = installation.target === "windows-x64"
        ? join(installation.root, "bin", "spotuify.exe")
        : join(dirname(dirname(installation.root)), "bin", "spotuify");
      await validateActive(active, expectedVersion);
      if (installation.target === "windows-x64") {
        await stageWindowsLauncher(
          installation.root,
          join(releaseDirectory, "spotuify-launcher.exe"),
        );
      }
    } catch (error) {
      await rollback();
      throw error;
    }
    return { version: expectedVersion, changed: true };
  } finally {
    if (!committed) await rm(staging, { recursive: true, force: true });
    await releaseLock();
  }
}

export function standaloneUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  return compareSemanticVersions(latestVersion, currentVersion) > 0;
}
