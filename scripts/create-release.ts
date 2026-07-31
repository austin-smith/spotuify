import { REPO_ROOT, productVersion } from "./release-config.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

async function git(repoRoot: string, args: string[]): Promise<CommandResult> {
  const process = Bun.spawn(["git", ...args], {
    cwd: repoRoot,
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

function commandError(args: string[], result: CommandResult): Error {
  const detail = result.stderr || result.stdout || `exit status ${result.exitCode}`;
  return new Error(`git ${args.join(" ")} failed: ${detail}`);
}

async function requireGit(repoRoot: string, args: string[]): Promise<string> {
  const result = await git(repoRoot, args);
  if (result.exitCode !== 0) throw commandError(args, result);
  return result.stdout;
}

export async function createRelease(
  version: string,
  repoRoot = REPO_ROOT,
): Promise<string> {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(`release version must use X.Y.Z format, received ${version}`);
  }
  const tag = `v${version}`;
  const branch = await requireGit(repoRoot, ["branch", "--show-current"]);
  if (branch !== "main") {
    throw new Error(`releases must be created from main; current branch is ${branch || "detached"}`);
  }

  const status = await requireGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error("working tree must be clean before creating a release");
  }

  await requireGit(repoRoot, ["fetch", "--quiet", "--tags", "origin"]);
  const [head, upstream] = await Promise.all([
    requireGit(repoRoot, ["rev-parse", "HEAD"]),
    requireGit(repoRoot, ["rev-parse", "refs/remotes/origin/main"]),
  ]);
  if (head !== upstream) {
    throw new Error("local main must exactly match origin/main before creating a release");
  }

  const tagRef = `refs/tags/${tag}`;
  const existingTag = await git(repoRoot, ["show-ref", "--verify", "--quiet", tagRef]);
  if (existingTag.exitCode === 0) {
    throw new Error(`release tag ${tag} already exists`);
  }
  if (existingTag.exitCode !== 1) {
    throw commandError(["show-ref", "--verify", "--quiet", tagRef], existingTag);
  }

  await requireGit(repoRoot, ["tag", "--sign", tag, "--message", tag]);
  const pushArgs = ["push", "--no-follow-tags", "origin", `${tagRef}:${tagRef}`];
  const push = await git(repoRoot, pushArgs);
  if (push.exitCode !== 0) {
    const cleanupArgs = ["tag", "--delete", tag];
    const cleanup = await git(repoRoot, cleanupArgs);
    if (cleanup.exitCode !== 0) {
      throw new Error(
        `${commandError(pushArgs, push).message}; ` +
          `cleanup also failed: ${commandError(cleanupArgs, cleanup).message}`,
      );
    }
    throw commandError(pushArgs, push);
  }

  console.log(`pushed ${tag}; GitHub Actions will publish the stable release`);
  return tag;
}

if (import.meta.main) {
  await createRelease(await productVersion());
}
