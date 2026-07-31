import { resolve } from "node:path";

export const REPOSITORY = "austin-smith/spotuify";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
export const HOMEBREW_TAP_REPOSITORY = "austin-smith/homebrew-tap";
export const HOMEBREW_FORMULA_PATH = "Formula/spotuify.rb";
export const MACOS_DEPLOYMENT_TARGET = "13.0";

export interface ReleaseTarget {
  readonly id: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly bunTarget:
    | "bun-darwin-arm64"
    | "bun-linux-arm64"
    | "bun-linux-x64-baseline"
    | "bun-windows-x64-baseline";
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
    bunTarget: "bun-windows-x64-baseline",
    archiveExtension: "zip",
  },
} as const satisfies Record<string, ReleaseTarget>;

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const DIST_DIR = resolve(REPO_ROOT, "dist");
export const STAGE_DIR = resolve(DIST_DIR, "stage");

function validVersion(value: unknown, source: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${source} must contain a valid semantic product version`);
  }
  return value;
}

export async function productVersion(): Promise<string> {
  const packageJson = await Bun.file(resolve(REPO_ROOT, "package.json")).json();
  const cargoToml = Bun.TOML.parse(
    await Bun.file(resolve(REPO_ROOT, "native", "Cargo.toml")).text(),
  ) as { package?: { version?: unknown; publish?: unknown } };
  const packageVersion = validVersion(packageJson.version, "package.json");
  const nativeVersion = validVersion(cargoToml.package?.version, "native/Cargo.toml");

  if (packageJson.private !== true) {
    throw new Error("package.json must keep private = true");
  }
  if (packageJson.packageManager !== `bun@${Bun.version}`) {
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

export function executableName(name: string, target: ReleaseTarget): string {
  return target.platform === "win32" ? `${name}.exe` : name;
}

export function releaseExecutableNames(target: ReleaseTarget): readonly [string, string] {
  return [executableName("spotuify", target), executableName("spotuify-engine", target)];
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
