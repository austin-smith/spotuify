import { resolve } from "node:path";
import {
  executableName,
  RELEASE_TARGETS,
  REPOSITORY_URL,
  type ReleaseTarget,
} from "./release-config.ts";

export const NPM_ROOT_PACKAGE = "spotuify";
export const NPM_DIST_DIR = resolve(import.meta.dir, "..", "dist", "npm");
export const NPM_STAGE_DIR = resolve(NPM_DIST_DIR, "stage");
export const NPM_LAUNCHER = resolve(
  import.meta.dir,
  "..",
  "packaging",
  "npm",
  "spotuify.cjs",
);

export const NPM_PLATFORM_PACKAGES = {
  "darwin-arm64": {
    name: "spotuify-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  },
  "linux-arm64": {
    name: "spotuify-linux-arm64",
    os: "linux",
    cpu: "arm64",
    libc: "glibc",
  },
  "linux-x64": {
    name: "spotuify-linux-x64",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
  },
  "windows-x64": {
    name: "spotuify-windows-x64",
    os: "win32",
    cpu: "x64",
  },
} as const satisfies Record<
  keyof typeof RELEASE_TARGETS,
  {
    readonly name: string;
    readonly os: NodeJS.Platform;
    readonly cpu: "arm64" | "x64";
    readonly libc?: "glibc";
  }
>;

export const NPM_PACKAGE_NAMES = [
  ...Object.values(NPM_PLATFORM_PACKAGES).map(({ name }) => name),
  NPM_ROOT_PACKAGE,
] as const;

const commonManifest = {
  license: "MIT",
  homepage: REPOSITORY_URL,
  repository: {
    type: "git",
    url: `${REPOSITORY_URL}.git`,
  },
  bugs: {
    url: `${REPOSITORY_URL}/issues`,
  },
} as const;

export function npmPlatformPackage(target: ReleaseTarget) {
  const platformPackage =
    NPM_PLATFORM_PACKAGES[target.id as keyof typeof NPM_PLATFORM_PACKAGES];
  if (platformPackage === undefined) {
    throw new Error(`no npm package is configured for ${target.id}`);
  }
  return platformPackage;
}

export function npmPlatformManifest(version: string, target: ReleaseTarget) {
  const platformPackage = npmPlatformPackage(target);
  return {
    name: platformPackage.name,
    version,
    description: `Platform binaries for spotuify on ${target.id}`,
    ...commonManifest,
    os: [platformPackage.os],
    cpu: [platformPackage.cpu],
    ...("libc" in platformPackage ? { libc: [platformPackage.libc] } : {}),
    files: ["bin"],
  };
}

export function npmRootManifest(version: string) {
  return {
    name: NPM_ROOT_PACKAGE,
    version,
    description: "Spotify in your terminal",
    ...commonManifest,
    bin: {
      spotuify: "bin/spotuify.cjs",
    },
    files: ["bin"],
    engines: {
      node: ">=18",
    },
    optionalDependencies: Object.fromEntries(
      Object.values(NPM_PLATFORM_PACKAGES).map(({ name }) => [name, version]),
    ),
  };
}

export function npmPackageTarballName(name: string, version: string): string {
  return `${name}-${version}.tgz`;
}

export function npmPackageExecutableNames(target: ReleaseTarget): readonly [string, string] {
  return [executableName("spotuify", target), executableName("spotuify-engine", target)];
}
