import { resolve } from "node:path";
import { isSemanticVersion, isStableVersion } from "../src/semver.ts";

export const REPOSITORY = "austin-smith/spotuify";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const PRODUCT_DESCRIPTION = "spotify in ur terminal";
export const HOMEBREW_DESCRIPTION = "Spotify client for the terminal";
export const HOMEBREW_TAP_REPOSITORY = "austin-smith/homebrew-tap";
export const HOMEBREW_FORMULA_PATH = "Formula/spotuify.rb";
export const HOMEBREW_METADATA_PATH = "metadata/spotuify.json";
export const MACOS_DEPLOYMENT_TARGET = "13.0";

export interface ReleaseTarget {
  readonly id: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly bunTarget:
    | "bun-darwin-arm64"
    | "bun-linux-arm64"
    | "bun-linux-x64-baseline"
    | "bun-windows-x64";
  readonly archiveExtension: "tar.gz" | "zip";
}

export const RELEASE_TARGETS = {
  "darwin-arm64": {
    id: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    archiveExtension: "tar.gz",
  },
  "linux-arm64": {
    id: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    bunTarget: "bun-linux-arm64",
    archiveExtension: "tar.gz",
  },
  "linux-x64": {
    id: "linux-x64",
    platform: "linux",
    arch: "x64",
    bunTarget: "bun-linux-x64-baseline",
    archiveExtension: "tar.gz",
  },
  "windows-x64": {
    id: "windows-x64",
    platform: "win32",
    arch: "x64",
    bunTarget: "bun-windows-x64",
    archiveExtension: "zip",
  },
} as const satisfies Record<string, ReleaseTarget>;

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const DIST_DIR = resolve(REPO_ROOT, "dist");
export const STAGE_DIR = resolve(DIST_DIR, "stage");
export const STANDALONE_STAGE_DIR = resolve(DIST_DIR, "standalone-stage");

function validSemanticVersion(value: unknown, source: string): string {
  if (!isSemanticVersion(value)) {
    throw new Error(`${source} must contain a valid semantic version`);
  }
  return value;
}

function validStableVersion(value: unknown, source: string): string {
  if (!isStableVersion(value)) {
    throw new Error(`${source} must contain a stable semantic version in X.Y.Z format`);
  }
  return value;
}

export async function productVersion(
  options: { requirePinnedPackageManager?: boolean } = {},
): Promise<string> {
  const packageJson = await Bun.file(resolve(REPO_ROOT, "package.json")).json();
  const cargoToml = Bun.TOML.parse(
    await Bun.file(resolve(REPO_ROOT, "native", "Cargo.toml")).text(),
  ) as { package?: { version?: unknown; publish?: unknown } };
  const packageVersion = validStableVersion(packageJson.version, "package.json");
  const nativeVersion = validStableVersion(cargoToml.package?.version, "native/Cargo.toml");

  if (packageJson.private !== true) {
    throw new Error("package.json must keep private = true");
  }
  if (
    options.requirePinnedPackageManager !== false &&
    packageJson.packageManager !== `bun@${Bun.version}`
  ) {
    throw new Error(
      `release scripts require ${packageJson.packageManager}, current runtime is bun@${Bun.version}`,
    );
  }
  if (packageVersion !== nativeVersion) {
    throw new Error(
      `product version mismatch: package.json=${packageVersion}, native/Cargo.toml=${nativeVersion}`,
    );
  }
  if (cargoToml.package?.publish !== false) {
    throw new Error("native/Cargo.toml must keep publish = false");
  }
  return packageVersion;
}

export async function buildVersion(): Promise<string> {
  const canonicalVersion = await productVersion();
  const override = Bun.env.SPOTUIFY_BUILD_VERSION;
  return override === undefined
    ? canonicalVersion
    : validSemanticVersion(override, "SPOTUIFY_BUILD_VERSION");
}

export function canaryVersion(
  canonicalVersion: string,
  runNumber: string,
  runCreatedAt: string,
): string {
  const version = validStableVersion(canonicalVersion, "canonical version");
  if (!/^[1-9]\d*$/.test(runNumber)) {
    throw new Error("GitHub run number must be a positive integer");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(runCreatedAt)) {
    throw new Error("GitHub workflow creation time must be an ISO 8601 UTC timestamp");
  }
  const createdAt = new Date(runCreatedAt);
  if (
    Number.isNaN(createdAt.getTime()) ||
    createdAt.toISOString() !== runCreatedAt.replace("Z", ".000Z")
  ) {
    throw new Error("GitHub workflow creation time must be a valid UTC timestamp");
  }
  const compactDate = runCreatedAt.slice(0, 10).replaceAll("-", "");
  return `${version}-canary.${compactDate}.${runNumber}`;
}

export function releaseTarget(argument = process.argv[2]): ReleaseTarget {
  if (argument === undefined || !(argument in RELEASE_TARGETS)) {
    throw new Error(
      `target must be one of: ${Object.keys(RELEASE_TARGETS).sort().join(", ")}`,
    );
  }
  return RELEASE_TARGETS[argument as keyof typeof RELEASE_TARGETS];
}

export function assertNativeHost(target: ReleaseTarget): void {
  if (process.platform !== target.platform || process.arch !== target.arch) {
    throw new Error(
      `${target.id} must be built natively on ${target.platform}/${target.arch}; ` +
        `current host is ${process.platform}/${process.arch}`,
    );
  }
}

export function artifactName(version: string, target: ReleaseTarget): string {
  return `spotuify-v${version}-${target.id}`;
}

export function archiveName(version: string, target: ReleaseTarget): string {
  return `${artifactName(version, target)}.${target.archiveExtension}`;
}

export function sourceArchiveName(version: string): string {
  return `spotuify-v${version}-source.tar.gz`;
}

export function hostReleaseTarget(
  platform = process.platform,
  architecture = process.arch,
): ReleaseTarget {
  const target = Object.values(RELEASE_TARGETS).find(
    (candidate) =>
      candidate.platform === platform && candidate.arch === architecture,
  );
  if (target === undefined || target.platform === "win32") {
    throw new Error(
      `Homebrew source builds require macOS arm64 or Linux arm64/x64; ` +
        `current host is ${platform}/${architecture}`,
    );
  }
  return target;
}

export function executableName(name: string, target: ReleaseTarget): string {
  return target.platform === "win32" ? `${name}.exe` : name;
}

export function releaseExecutableNames(target: ReleaseTarget): readonly [string, string] {
  return [executableName("spotuify", target), executableName("spotuify-engine", target)];
}

export function standaloneComponentName(
  version: string,
  target: ReleaseTarget,
  component: "spotuify" | "engine" | "launcher",
): string {
  const extension = target.platform === "win32" ? ".exe" : "";
  return `${artifactName(version, target)}-standalone-${component}${extension}`;
}

export function standaloneComponentNames(
  version: string,
  target: ReleaseTarget,
): readonly string[] {
  return [
    standaloneComponentName(version, target, "spotuify"),
    standaloneComponentName(version, target, "engine"),
    ...(target.platform === "win32"
      ? [standaloneComponentName(version, target, "launcher")]
      : []),
  ];
}

export function normalizeCommandOutput(stdout: string): string {
  return stdout.replaceAll("\r\n", "\n").trim();
}

export async function captureCommandOutput(command: string[]): Promise<string> {
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
  return normalizeCommandOutput(stdout);
}

export async function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  console.log(`$ ${command.join(" ")}`);
  const process = Bun.spawn(command, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...Bun.env, ...options.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited with status ${exitCode}`);
  }
}
