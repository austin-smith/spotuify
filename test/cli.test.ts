import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import packageMetadata from "../package.json";
import { PLAIN_HELP } from "../src/cli/presenter.ts";
import { formatSoftwareLicenses, softwareLicenses } from "../src/licenses.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test.each(["-v", "--version"])(
  "%s exits without renderer or authentication side effects",
  async (versionFlag) => {
    directory = await mkdtemp(join(tmpdir(), "spotuify-version-test-"));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, cli, versionFlag], {
      cwd: directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
        SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 2_000);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timeout);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`spotuify ${packageMetadata.version}\n`);
    expect(stderr).toBe("");
    expect(await readdir(directory)).toEqual([]);
  },
);

test.each(["help", "-h", "--help"])("%s prints stable help without side effects", async (flag) => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-help-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, flag], {
    cwd: directory,
    env: {
      ...process.env,
      CI: "true",
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toBe(PLAIN_HELP);
  expect(stderr).toBe("");
  expect(await readdir(directory)).toEqual([]);
});

test("licenses prints embedded legal notices without side effects", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-licenses-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "licenses"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 2_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);

  expect(exitCode).toBe(0);
  expect(stdout).toBe(`${await softwareLicenses()}\n`);
  expect(stderr).toBe("");
  expect(await readdir(directory)).toEqual([]);
});

test("update rejects unsupported arguments before any network or renderer work", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-update-cli-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "update", "--unknown"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toBe("Invalid update options.\nUsage: spotuify update [--check]\n");
  expect(await readdir(directory)).toEqual([]);
});

test("auth rejects unsupported arguments before setup or network work", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-auth-cli-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "auth", "--unknown"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toBe(
    "Invalid auth options.\nUsage: spotuify auth [--force] [--force-engine] [--reset]\n",
  );
  expect(await readdir(directory)).toEqual([]);
});

test("software licenses are independent of checkout line endings", () => {
  const unix = formatSoftwareLicenses("license\ntext\n", "notice\ntext\n");
  const windows = formatSoftwareLicenses("license\r\ntext\r\n", "notice\r\ntext\r\n");

  expect(windows).toBe(unix);
  expect(windows).not.toContain("\r");
});
