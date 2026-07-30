import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("--version exits without renderer or authentication side effects", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-version-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--version"], {
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
  expect(stdout).toBe("spotuify 0.1.0\n");
  expect(stderr).toBe("");
  expect(await readdir(directory)).toEqual([]);
});
