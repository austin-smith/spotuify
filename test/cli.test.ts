import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import packageMetadata from "../package.json";
import { formatSoftwareLicenses, softwareLicenses } from "../src/licenses.ts";

let directory: string | undefined;

async function expectNoApplicationState(root: string): Promise<void> {
  expect(await Bun.file(join(root, "config", "spotuify", "config.json")).exists()).toBe(false);
  expect(await Bun.file(join(root, "config", "spotuify", "token.json")).exists()).toBe(false);
  expect(await Bun.file(join(root, "cache", "spotuify", "update.json")).exists()).toBe(false);
}

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
    await expectNoApplicationState(directory);
  },
);

test.each(["help", "-h", "--help"])("%s prints comprehensive help without application side effects", async (flag) => {
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
  expect(stdout).toContain("Usage: spotuify [options] [command]");
  expect(stdout).toContain("Playback");
  expect(stdout).toContain("Browse");
  expect(stdout).toContain("Library");
  expect(stdout).toContain("Setup & system");
  expect(stdout).toContain("General options");
  expect(stdout).toContain("Output");
  expect(stdout).toContain("Composition");
  expect(stdout).not.toContain("--color");
  expect(stdout).toContain("playlist");
  expect(stdout).toContain("--output <mode>");
  expect(stdout).toContain("service");
  expect(stderr).toBe("");
  await expectNoApplicationState(directory);
});

test("help output documents composition without application side effects", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-output-help-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "help", "output"], {
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
  expect(stdout).toContain("Usage: spotuify <command> [output options]");
  expect(stdout).toContain("Output:");
  expect(stdout).toContain("Composition:");
  expect(stdout).toContain("spotuify status --template");
  expect(stderr).toBe("");
  await expectNoApplicationState(directory);
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
  await expectNoApplicationState(directory);
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
  expect(stderr).toBe("error: unknown option '--unknown'\nRun 'spotuify --help' for usage.\n");
  await expectNoApplicationState(directory);
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
  expect(stderr).toBe("error: unknown option '--unknown'\nRun 'spotuify --help' for usage.\n");
  await expectNoApplicationState(directory);
});

test("usage errors stay machine-readable in JSON mode", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-json-error-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", "not-a-command"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
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
  expect(JSON.parse(stderr)).toMatchObject({
    schema_version: 1,
    error: { code: "usage_error" },
  });
  await expectNoApplicationState(directory);
});

test("attached short JSON output keeps parser errors machine-readable", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-short-json-error-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "-ojson", "not-a-command"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({
    error: { code: "usage_error" },
  });
});

test.each([
  { command: "seek", args: ["seek", "30", "--unknown"] },
  { command: "volume", args: ["volume", "50", "--unknown"] },
])("$command rejects unknown mutation options", async ({ args }) => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-mutation-option-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({
    error: { code: "usage_error" },
  });
});

test.each([
  {
    name: "an indexed artist context",
    args: ["play", "spotify:artist:abc123", "--index", "3"],
    message: "album or playlist",
  },
  {
    name: "an artist library mutation",
    args: ["library", "save", "spotify:artist:abc123"],
    message: "cannot be saved",
  },
])("rejects $name before authentication", async ({ args, message }) => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-resource-usage-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({
    error: {
      code: "usage_error",
      message: expect.stringContaining(message),
    },
  });
});

test("play rejects --index without a context before playback work", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-play-index-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn(
    [process.execPath, cli, "--json", "play", "--index", "3"],
    {
      cwd: directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({
    error: {
      code: "usage_error",
      message: expect.stringContaining("--index requires"),
    },
  });
  await expectNoApplicationState(directory);
});

test("play rejects unsupported show contexts before playback work", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-play-show-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn(
    [process.execPath, cli, "--json", "play", "spotify:show:abc123"],
    {
      cwd: directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({
    error: {
      code: "usage_error",
      message: expect.stringContaining("spotuify show"),
    },
  });
  await expectNoApplicationState(directory);
});

test("playlist replace without items reaches the documented clear operation", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-playlist-clear-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "--json",
      "playlist",
      "replace",
      "spotify:playlist:abc123",
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(3);
  expect(JSON.parse(stderr)).toMatchObject({
    error: { code: "authentication_required" },
  });
});

test.each([
  {
    name: "public collaborative playlist creation",
    args: ["playlist", "create", "Shared", "--public", "--collaborative"],
    message: "must be private",
  },
  {
    name: "an empty playlist edit",
    args: ["playlist", "edit", "spotify:playlist:abc123"],
    message: "At least one playlist change",
  },
])("playlist validation rejects $name before authentication", async ({ args, message }) => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-playlist-usage-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(JSON.parse(stderr)).toMatchObject({
    error: {
      code: "usage_error",
      message: expect.stringContaining(message),
    },
  });
  await expectNoApplicationState(directory);
});

test("doctor treats a missing config file as optional when effective config resolves", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-doctor-config-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", "doctor"], {
    cwd: directory,
    env: {
      ...process.env,
      SPOTUIFY_CLIENT_ID: "test-client-id",
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      SPOTUIFY_ENGINE_PATH: join(directory, "missing-engine"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
    new Response(child.stderr).text(),
  ]);
  const result = JSON.parse(stdout) as {
    data: { checks: { name: string; ok: boolean; detail: string }[] };
  };

  expect(result.data.checks).toContainEqual({
    name: "config_file",
    ok: true,
    detail: expect.stringContaining("optional"),
  });
});

test("conflicting output flags fail before a playlist mutation", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-output-guard-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "--json",
      "--plain",
      "playlist",
      "replace",
      "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({
    schema_version: 1,
    error: { code: "usage_error" },
  });
  await expectNoApplicationState(directory);
});

test.each(["auth", "licenses", "completion zsh"])(
  "%s rejects incompatible machine formatting before side effects",
  async (invocation) => {
    directory = await mkdtemp(join(tmpdir(), "spotuify-raw-output-test-"));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn(
      [process.execPath, cli, "--json", ...invocation.split(" ")],
      {
        cwd: directory,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_CACHE_HOME: join(directory, "cache"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      schema_version: 1,
      error: { code: "usage_error" },
    });
    await expectNoApplicationState(directory);
  },
);

test("software licenses are independent of checkout line endings", () => {
  const unix = formatSoftwareLicenses("license\ntext\n", "notice\ntext\n");
  const windows = formatSoftwareLicenses("license\r\ntext\r\n", "notice\r\ntext\r\n");

  expect(windows).toBe(unix);
  expect(windows).not.toContain("\r");
});

test.each([
  [["follow", "add", "spotify:track:abc123"], "cannot be followed"],
  [
    ["history", "recent", "--before", "123", "--after", "456"],
    "only one of --before or --after",
  ],
  [["search", "oliver", "tree", "--limit", "51"], "cannot exceed 50"],
] as [string[], string][])(
  "%j is rejected before any session or network work",
  async (argv, message) => {
    directory = await mkdtemp(join(tmpdir(), "spotuify-usage-test-"));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, cli, "--json", ...argv], {
      cwd: directory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CACHE_HOME: join(directory, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({
      error: {
        code: "usage_error",
        message: expect.stringContaining(message),
      },
    });
    await expectNoApplicationState(directory);
  },
);

test("logout succeeds without stored credentials and reports what it found", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-logout-test-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", "logout"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      // Probe an isolated runtime dir; a live session on the host must not leak into the test.
      SPOTUIFY_RUNTIME_DIR: join(directory, "runtime"),
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
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    command: "logout",
    data: { ok: true, web_api: false, playback: false, runtime_active: false },
  });
  await expectNoApplicationState(directory);
});

test("logout removes stored web credentials but keeps the client configuration", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-logout-state-test-"));
  const configDir = join(directory, "config", "spotuify");
  await Bun.write(join(configDir, "token.json"), "{}");
  await Bun.write(join(configDir, "config.json"), JSON.stringify({ clientId: "abc" }));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, cli, "--json", "logout"], {
    cwd: directory,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
      // Probe an isolated runtime dir; a live session on the host must not leak into the test.
      SPOTUIFY_RUNTIME_DIR: join(directory, "runtime"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ data: { ok: true, web_api: true } });
  expect(await Bun.file(join(configDir, "token.json")).exists()).toBe(false);
  expect(await Bun.file(join(configDir, "config.json")).exists()).toBe(true);
});
