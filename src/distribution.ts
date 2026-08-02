import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

declare const SPOTUIFY_STANDALONE: boolean | undefined;

export const STANDALONE_MARKER_NAME = ".spotuify-install.json";
export const STANDALONE_MANAGER = "spotuify-installer";

export type StandaloneTarget =
  | "darwin-arm64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

export interface StandaloneInstallation {
  root: string;
  releaseDirectory: string;
  releaseName: string;
  target: StandaloneTarget;
}

export type InstallSource = "npm" | "homebrew" | "standalone" | "direct" | "source";

export function isStandaloneBuild(): boolean {
  return typeof SPOTUIFY_STANDALONE !== "undefined" && SPOTUIFY_STANDALONE === true;
}

function expectedTarget(
  platform: NodeJS.Platform,
  architecture: string,
): StandaloneTarget | undefined {
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "linux" && architecture === "arm64") return "linux-arm64";
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  return undefined;
}

function markerTarget(path: string): StandaloneTarget | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const marker = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof marker !== "object" || marker === null) return undefined;
    const value = marker as Record<string, unknown>;
    if (value["schema"] !== 1 || value["manager"] !== STANDALONE_MANAGER) {
      return undefined;
    }
    const target = value["target"];
    return target === "darwin-arm64" ||
        target === "linux-arm64" ||
        target === "linux-x64" ||
        target === "windows-x64"
      ? target
      : undefined;
  } catch {
    return undefined;
  }
}

function regularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export function standaloneInstallation(
  executablePath = process.execPath,
  platform = process.platform,
  architecture = process.arch,
  configuredRoot = process.env["SPOTUIFY_INSTALL_ROOT"],
): StandaloneInstallation | undefined {
  const target = expectedTarget(platform, architecture);
  if (target === undefined) return undefined;

  let executable: string;
  try {
    executable = realpathSync(resolve(executablePath));
  } catch {
    return undefined;
  }
  const releaseDirectory = dirname(executable);
  const releasesDirectory = dirname(releaseDirectory);
  const derivedRoot = dirname(releasesDirectory);
  let root = derivedRoot;
  if (configuredRoot && isAbsolute(configuredRoot)) {
    try {
      root = realpathSync(resolve(configuredRoot));
    } catch {
      return undefined;
    }
  }
  if (root !== derivedRoot || basename(releasesDirectory) !== "releases") return undefined;
  if (relative(join(root, "releases"), releaseDirectory).startsWith("..")) return undefined;
  if (basename(executable).toLowerCase() !== (platform === "win32" ? "spotuify.exe" : "spotuify")) {
    return undefined;
  }
  if (markerTarget(join(root, STANDALONE_MARKER_NAME)) !== target) return undefined;

  const releaseName = basename(releaseDirectory);
  if (!releaseName.endsWith(`-${target}`)) return undefined;
  const version = releaseName.slice(0, -(target.length + 1));
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    return undefined;
  }

  try {
    if (platform === "win32") {
      if (!regularFile(join(root, "current"))) return undefined;
      if (readFileSync(join(root, "current"), "utf8").trim() !== releaseName) {
        return undefined;
      }
      if (
        !regularFile(join(root, "bin", "spotuify.exe")) ||
        !regularFile(join(releaseDirectory, "spotuify-engine.exe"))
      ) {
        return undefined;
      }
    } else {
      if (realpathSync(join(root, "current")) !== releaseDirectory) return undefined;
      const prefix = dirname(dirname(root));
      if (
        realpathSync(join(prefix, "bin", "spotuify")) !== executable ||
        realpathSync(join(prefix, "libexec", "spotuify-engine")) !==
          join(releaseDirectory, "spotuify-engine")
      ) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return { root, releaseDirectory, releaseName, target };
}

/** Package-manager wrappers stamp their source; installer ownership requires a managed marker. */
export function installSource(
  value = process.env["SPOTUIFY_INSTALL_SOURCE"],
  standalone = isStandaloneBuild(),
  managed = standalone ? standaloneInstallation() : undefined,
): InstallSource {
  if (value === "npm" || value === "homebrew") return value;
  if (managed !== undefined) return "standalone";
  return standalone ? "direct" : "source";
}
