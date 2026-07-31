import { realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { installSource, type InstallSource } from "./distribution.ts";
import {
  checkForUpdate,
  UPDATE_AVAILABLE_EXIT_CODE,
  type UpdateCheckResult,
} from "./update.ts";

type Check = typeof checkForUpdate;
type Run = (command: readonly string[]) => Promise<number>;
type NpmInvocation = (channel: "latest" | "canary") => readonly string[];

interface UpdateCommandOptions {
  currentVersion: string;
  checkOnly: boolean;
  source?: InstallSource;
  check?: Check;
  run?: Run;
  npmInvocation?: NpmInvocation;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

async function runProcess(command: readonly string[]): Promise<number> {
  const child = Bun.spawn([...command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(environment).find(
    ([key]) => key.toUpperCase() === name.toUpperCase(),
  )?.[1];
}

export interface NpmLauncher {
  executable: string;
  argsPrefix: string[];
}

export function resolveWindowsNpmLauncher(
  environment: NodeJS.ProcessEnv = process.env,
  nodeExecutable = process.execPath,
  currentDirectory = process.cwd(),
  isFile: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
): NpmLauncher {
  const workingDirectory = win32.resolve(currentDirectory).toLowerCase();
  const pathDirectories = (environmentValue(environment, "PATH") ?? "").split(
    win32.delimiter,
  );
  const visited = new Set<string>();
  const trustedDirectories: string[] = [];
  const addDirectory = (rawDirectory: string, allowWorkingDirectory: boolean): void => {
    if (rawDirectory.length === 0 || !win32.isAbsolute(rawDirectory)) return;
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

export function resolvePosixNpmLauncher(
  nodeExecutable = process.execPath,
  isFile: (path: string) => boolean = (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path: string) => string = realpathSync,
): NpmLauncher {
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

export function npmUpdateInvocation(
  channel: "latest" | "canary",
  platform = process.platform,
  npmLauncher = platform === "win32"
    ? resolveWindowsNpmLauncher()
    : resolvePosixNpmLauncher(),
): readonly string[] {
  const args = ["install", "--global", `spotuify@${channel}`];
  if (npmLauncher === undefined) throw new Error("missing npm runtime");
  return [npmLauncher.executable, ...npmLauncher.argsPrefix, ...args];
}

function describeCurrent(result: Extract<UpdateCheckResult, { status: "current" }>): string {
  if (result.latestVersion === null) {
    return `No ${result.channel} release is published for ${result.source} yet.`;
  }
  return result.ahead
    ? `spotuify ${result.currentVersion} is newer than ${result.source}'s ${result.channel} release ${result.latestVersion}.`
    : `spotuify ${result.currentVersion} is up to date.`;
}

export async function runUpdateCommand(options: UpdateCommandOptions): Promise<number> {
  const source = options.source ?? installSource();
  const check = options.check ?? checkForUpdate;
  const run = options.run ?? runProcess;
  const npmInvocation = options.npmInvocation ?? npmUpdateInvocation;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const result = await check({
    currentVersion: options.currentVersion,
    source,
    force: true,
    respectOptOut: false,
  });

  switch (result.status) {
    case "disabled":
      // Explicit update commands do not respect the passive-check opt-out, so this is only
      // possible with an injected checker that violates the normal contract.
      stderr("The update check is disabled.");
      return 1;
    case "unsupported":
      if (result.source === "source") {
        stderr("Source builds are updated through git; pull the repository and rebuild spotuify.");
      } else {
        stderr(
          "Direct-download builds cannot be replaced automatically. Download the latest release from https://github.com/austin-smith/spotuify/releases.",
        );
      }
      return 1;
    case "unavailable":
      stderr(`Could not check for updates: ${result.message}`);
      return 1;
    case "current":
      stdout(describeCurrent(result));
      return 0;
    case "available":
      stdout(
        `spotuify ${result.currentVersion} → ${result.latestVersion} is available via ${result.source}.`,
      );
      if (options.checkOnly) {
        stdout(`Run \`spotuify update\` or: ${result.command}`);
        return UPDATE_AVAILABLE_EXIT_CODE;
      }

      if (result.source === "homebrew") {
        const updateExit = await run(["brew", "update"]);
        if (updateExit !== 0) return updateExit;
        const upgradeExit = await run([
          "brew",
          "upgrade",
          "austin-smith/tap/spotuify",
        ]);
        if (upgradeExit !== 0) return upgradeExit;
      } else {
        const installExit = await run(npmInvocation(result.channel));
        if (installExit !== 0) return installExit;
      }

      stdout(`Updated spotuify to ${result.latestVersion}. Restart spotuify to use it.`);
      return 0;
  }
}
