import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRelease } from "../scripts/create-release.ts";

interface RepositoryFixture {
  readonly root: string;
  readonly repository: string;
  readonly remote: string;
}

async function command(cwd: string, executable: string, args: string[]): Promise<string> {
  const process = Bun.spawn([executable, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return command(cwd, "git", args);
}

const FIXTURE_CHANGELOG = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-01-01

### Added

- A releasable change.

[unreleased]: https://example.com/compare/v1.2.3...HEAD
[1.2.3]: https://example.com/releases/tag/v1.2.3
`;

async function repositoryFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "spotuify-create-release-"));
  const repository = resolve(root, "repository");
  const remote = resolve(root, "remote.git");
  await mkdir(repository);
  await git(root, ["init", "--bare", remote]);
  await git(repository, ["init", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Release Test"]);
  await git(repository, ["config", "user.email", "release-test@example.com"]);
  await Bun.write(resolve(repository, "tracked.txt"), "initial\n");
  await Bun.write(resolve(repository, "CHANGELOG.md"), FIXTURE_CHANGELOG);
  await git(repository, ["add", "tracked.txt", "CHANGELOG.md"]);
  await git(repository, ["commit", "--message", "initial"]);
  await git(repository, ["remote", "add", "origin", remote]);
  await git(repository, ["push", "--set-upstream", "origin", "main"]);
  return { root, repository, remote };
}

test("creates and pushes only the canonical annotated release tag", async () => {
  const fixture = await repositoryFixture();
  try {
    await git(fixture.repository, [
      "tag",
      "--annotate",
      "v1.1.0",
      "--message",
      "v1.1.0",
    ]);
    // The release command must override a developer's global signing preference instead of
    // inheriting a workstation-specific GPG dependency.
    await git(fixture.repository, ["config", "tag.gpgSign", "true"]);
    await git(fixture.repository, ["config", "gpg.program", "missing-test-gpg"]);
    await git(fixture.repository, ["config", "push.followTags", "true"]);
    await expect(createRelease("1.2.3", fixture.repository)).resolves.toBe("v1.2.3");
    const head = await git(fixture.repository, ["rev-parse", "HEAD"]);
    const tagType = await git(fixture.repository, ["cat-file", "-t", "v1.2.3"]);
    const tagObject = await git(fixture.repository, ["cat-file", "-p", "v1.2.3"]);
    const localTag = await git(fixture.repository, ["rev-list", "-n", "1", "v1.2.3"]);
    const remoteTag = await git(fixture.remote, ["rev-list", "-n", "1", "v1.2.3"]);
    const unrelatedRemoteTag = await git(fixture.remote, ["tag", "--list", "v1.1.0"]);
    expect(tagType).toBe("tag");
    expect(tagObject.split("\n\n").at(-1)).toBe("v1.2.3");
    expect(tagObject).not.toContain("SIGNATURE");
    expect(localTag).toBe(head);
    expect(remoteTag).toBe(head);
    expect(unrelatedRemoteTag).toBe("");
    await expect(createRelease("1.2.3", fixture.repository)).rejects.toThrow(
      "already exists",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to release a version without changelog notes", async () => {
  const fixture = await repositoryFixture();
  try {
    await expect(createRelease("1.3.0", fixture.repository)).rejects.toThrow(
      "no release section for 1.3.0",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to release from a dirty worktree", async () => {
  const fixture = await repositoryFixture();
  try {
    await Bun.write(resolve(fixture.repository, "untracked.txt"), "dirty\n");
    await expect(createRelease("1.2.3", fixture.repository)).rejects.toThrow(
      "working tree must be clean",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to release outside main", async () => {
  const fixture = await repositoryFixture();
  try {
    await git(fixture.repository, ["switch", "--create", "release-work"]);
    await expect(createRelease("1.2.3", fixture.repository)).rejects.toThrow(
      "releases must be created from main",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses to release when local main differs from origin", async () => {
  const fixture = await repositoryFixture();
  try {
    await Bun.write(resolve(fixture.repository, "tracked.txt"), "ahead\n");
    await git(fixture.repository, ["add", "tracked.txt"]);
    await git(fixture.repository, ["commit", "--message", "ahead"]);
    await expect(createRelease("1.2.3", fixture.repository)).rejects.toThrow(
      "must exactly match origin/main",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("removes the local tag when the remote rejects the push", async () => {
  const fixture = await repositoryFixture();
  try {
    const hook = resolve(fixture.remote, "hooks", "pre-receive");
    await Bun.write(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await expect(createRelease("1.2.3", fixture.repository)).rejects.toThrow(
      "git push --no-follow-tags origin",
    );
    expect(await git(fixture.repository, ["tag", "--list", "v1.2.3"])).toBe("");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
