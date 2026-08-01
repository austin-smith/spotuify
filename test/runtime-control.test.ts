import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  controlPaths,
  RuntimeAlreadyRunningError,
  RuntimeRemoteError,
  RuntimeRequestUncertainError,
  RuntimeUnavailableError,
  runtimeRequest,
  startControlServer,
  tryRuntimeRequest,
  type ControlPaths,
  type ControlServer,
} from "../src/runtime/control.ts";
import { asCliError, CliError, ExitCode } from "../src/cli/errors.ts";

let server: ControlServer | undefined;
let rawServer: Server | undefined;
const directories: string[] = [];

async function paths(): Promise<ControlPaths> {
  const socketRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const directory = await mkdtemp(join(socketRoot, "spotuify-control-test-"));
  directories.push(directory);
  return {
    directory,
    descriptor: join(directory, "control.json"),
    endpoint: join(directory, "control.sock"),
  };
}

afterEach(async () => {
  await server?.close();
  await new Promise<void>(
    (resolve) => rawServer?.close(() => resolve()) ?? resolve(),
  );
  server = undefined;
  rawServer = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local runtime control", () => {
  test("prefers a short XDG runtime path and safely falls back for long sockets", () => {
    expect(
      controlPaths({ XDG_RUNTIME_DIR: "/run/user/501" }, "linux", 501),
    ).toMatchObject({
      directory: "/run/user/501/spotuify",
      endpoint: "/run/user/501/spotuify/control.sock",
    });
    expect(
      controlPaths(
        { XDG_RUNTIME_DIR: `/${"very-long/".repeat(20)}` },
        "darwin",
        501,
      ).directory,
    ).toBe("/tmp/spotuify-501");
    expect(
      controlPaths(
        { SPOTUIFY_RUNTIME_DIR: "/private/tmp/custom-spotuify" },
        "darwin",
        501,
      ).directory,
    ).toBe("/private/tmp/custom-spotuify");
  });

  test("round-trips authenticated JSON-RPC and removes owned files", async () => {
    const control = await paths();
    server = await startControlServer(
      (method, params) => ({ method, params }),
      { paths: control },
    );
    expect(
      await runtimeRequest("example", { value: 7 }, { paths: control }),
    ).toEqual({ method: "example", params: { value: 7 } });
    if (process.platform !== "win32") {
      expect((await stat(control.descriptor)).mode & 0o077).toBe(0);
      expect((await stat(control.endpoint)).mode & 0o077).toBe(0);
    }
    await server.close();
    server = undefined;
    await expect(
      runtimeRequest("ping", {}, { paths: control }),
    ).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  test("does not replace a live runtime", async () => {
    const control = await paths();
    server = await startControlServer(() => ({ ok: true }), { paths: control });
    await expect(
      startControlServer(() => ({ ok: false }), { paths: control }),
    ).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);
  });

  test("keeps a startup claim private until the initialized runtime publishes it", async () => {
    const control = await paths();
    server = await startControlServer(() => ({ ok: true }), {
      paths: control,
      publish: false,
    });

    expect(await tryRuntimeRequest("ping", {}, { paths: control })).toEqual({
      connected: false,
    });
    await expect(
      startControlServer(() => ({ replacement: true }), { paths: control }),
    ).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);

    await server.publish();
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
  });

  test("serializes concurrent startup so only one runtime can bind", async () => {
    const control = await paths();
    const outcomes = await Promise.allSettled([
      startControlServer(() => ({ owner: "first" }), { paths: control }),
      startControlServer(() => ({ owner: "second" }), { paths: control }),
    ]);
    const started = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<ControlServer> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(RuntimeAlreadyRunningError);
    server = started[0]!.value;
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
  });

  test("recovers an abandoned atomic startup claim", async () => {
    const control = await paths();
    await writeFile(
      join(control.directory, "startup.lock"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "abandoned-startup",
        createdAt: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    server = await startControlServer(() => ({ ok: true }), { paths: control });
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
    expect(await Bun.file(join(control.directory, "startup.lock")).exists()).toBe(
      false,
    );
  });

  test("recovers a malformed startup claim after its safety window", async () => {
    const control = await paths();
    const lock = join(control.directory, "startup.lock");
    await writeFile(lock, "incomplete", { mode: 0o600 });
    const stale = new Date(Date.now() - 31_000);
    await utimes(lock, stale, stale);

    server = await startControlServer(() => ({ ok: true }), { paths: control });
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
    expect(await Bun.file(lock).exists()).toBe(false);
  });

  test("never falls back after a runtime request may have executed", async () => {
    const control = await paths();
    let calls = 0;
    server = await startControlServer(
      async () => {
        calls++;
        await Bun.sleep(60);
        return { ok: true };
      },
      { paths: control },
    );

    await expect(
      tryRuntimeRequest("slow-mutation", {}, { paths: control, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(RuntimeRequestUncertainError);
    await Bun.sleep(80);
    expect(calls).toBe(1);
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
  });

  test("rejects a symlinked runtime directory without chmodding its target", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "spotuify-runtime-link-test-"));
    directories.push(root);
    const target = join(root, "target");
    const linked = join(root, "runtime");
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, linked);
    const control = {
      directory: linked,
      descriptor: join(linked, "control.json"),
      endpoint: join(linked, "control.sock"),
    };

    await expect(
      startControlServer(() => ({ ok: true }), { paths: control }),
    ).rejects.toThrow("must be a real directory");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  test("rejects malformed token values without destabilizing the server", async () => {
    const control = await paths();
    server = await startControlServer(() => ({ ok: true }), { paths: control });
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(control.endpoint);
      let value = "";
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: "bad-token",
            method: "ping",
            token: { length: 2 ** 31 },
          })}\n`,
        );
      });
      socket.on("data", (chunk) => (value += chunk.toString("utf8")));
      socket.once("end", () => resolve(value));
    });
    expect(JSON.parse(rawResponse)).toMatchObject({
      id: "",
      error: { code: -32700 },
    });
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
  });

  test("rolls back a listening endpoint when descriptor publication fails", async () => {
    const control = await paths();
    const invalid = { ...control, descriptor: control.directory };
    await expect(
      startControlServer(() => ({ ok: true }), { paths: invalid }),
    ).rejects.toBeDefined();
    await expect(stat(control.endpoint)).rejects.toBeDefined();

    server = await startControlServer(() => ({ ok: true }), { paths: control });
    expect(await runtimeRequest("ping", {}, { paths: control })).toMatchObject({
      protocolVersion: 2,
    });
  });

  test("never removes a successor endpoint or replacement descriptor after close", async () => {
    const control = await paths();
    server = await startControlServer(() => ({ ok: true }), { paths: control });
    const replacement = {
      ...server.descriptor,
      pid: server.descriptor.pid + 1,
      token: "replacement-owner-token",
    };
    await writeFile(
      control.descriptor,
      `${JSON.stringify(replacement)}\n`,
      "utf8",
    );

    await server.close();
    server = undefined;
    expect(await Bun.file(control.descriptor).json()).toMatchObject({
      token: "replacement-owner-token",
    });
    if (process.platform === "win32") return;
    rawServer = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      rawServer!.once("error", reject);
      rawServer!.listen(control.endpoint, resolve);
    });
    await Bun.sleep(10);
    expect((await stat(control.endpoint)).isSocket()).toBe(true);
  });

  test("preserves classified CLI failures across the runtime boundary", async () => {
    const control = await paths();
    server = await startControlServer(
      () => {
        throw new CliError(
          "Playback is temporarily unavailable.",
          ExitCode.temporary,
          "spotify_unavailable",
          "Try again later.",
        );
      },
      { paths: control },
    );
    const remote = await runtimeRequest("fail", {}, { paths: control }).catch(
      (error: unknown) => error,
    );
    expect(remote).toBeInstanceOf(RuntimeRemoteError);
    expect(asCliError(remote)).toMatchObject({
      exitCode: ExitCode.temporary,
      code: "spotify_unavailable",
      hint: "Try again later.",
    });
  });

  test("does not unlink a live endpoint whose descriptor disappeared", async () => {
    const control = await paths();
    rawServer = createServer();
    await new Promise<void>((resolve, reject) => {
      rawServer!.once("error", reject);
      rawServer!.listen(control.endpoint, resolve);
    });
    await expect(
      startControlServer(() => ({ ok: false }), { paths: control }),
    ).rejects.toBeInstanceOf(RuntimeAlreadyRunningError);
  });

  test("offers a non-throwing availability probe", async () => {
    const control = await paths();
    expect(await tryRuntimeRequest("ping", {}, { paths: control })).toEqual({
      connected: false,
    });
  });

  test("lets a separate CLI prefer runtime state without Web API setup", async () => {
    const control = await paths();
    server = await startControlServer(
      (method) => {
        if (method !== "status") throw new Error("unexpected method");
        return {
          source: "runtime",
          active: true,
          isPlaying: false,
          item: null,
          progressMs: 0,
          durationMs: 0,
          shuffle: false,
          repeat: "off",
          device: null,
        };
      },
      { paths: control, kind: "tui" },
    );
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, cli, "--json", "status"], {
      env: {
        ...process.env,
        SPOTUIFY_RUNTIME_DIR: control.directory,
        XDG_CONFIG_HOME: join(control.directory, "missing-config"),
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
      schema_version: 1,
      command: "status",
      data: {
        active: true,
        is_playing: false,
        item: null,
        progress_ms: 0,
        duration_ms: 0,
        shuffle: false,
        repeat: "off",
        context_uri: null,
        device: null,
      },
    });
  });

  test("accepts a negative compact seek as a positional argument", async () => {
    const control = await paths();
    let seekPosition: unknown;
    server = await startControlServer(
      (method, params) => {
        if (method === "status")
          return {
            active: true,
            isPlaying: true,
            item: null,
            progressMs: 30_000,
            durationMs: 180_000,
            shuffle: false,
            repeat: "off",
            device: null,
          };
        if (method === "seek") {
          seekPosition = (params as Record<string, unknown>)["positionMs"];
          return { progressMs: seekPosition };
        }
        throw new Error("unexpected method");
      },
      { paths: control },
    );
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn(
      [process.execPath, cli, "--json", "seek", "-15s"],
      {
        env: { ...process.env, SPOTUIFY_RUNTIME_DIR: control.directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(seekPosition).toBe(15_000);
  });

  test("accepts a documented negative relative volume", async () => {
    const control = await paths();
    let volume: unknown;
    server = await startControlServer(
      (method, params) => {
        if (method === "status") {
          return {
            active: true,
            isPlaying: true,
            item: null,
            progressMs: 0,
            durationMs: 0,
            shuffle: false,
            repeat: "off",
            device: {
              id: "device",
              name: "Speaker",
              volumePercent: 50,
            },
          };
        }
        if (method === "volume") {
          volume = (params as Record<string, unknown>)["percent"];
          return { volumePercent: volume };
        }
        throw new Error("unexpected method");
      },
      { paths: control },
    );
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn(
      [process.execPath, cli, "--json", "volume", "-5"],
      {
        env: { ...process.env, SPOTUIFY_RUNTIME_DIR: control.directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(volume).toBe(45);
  });

  test("interrupts a long status watch immediately", async () => {
    const control = await paths();
    server = await startControlServer(
      () => ({
        active: false,
        isPlaying: false,
        item: null,
        progressMs: 0,
        durationMs: 0,
        shuffle: false,
        repeat: "off",
        device: null,
      }),
      { paths: control },
    );
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn(
      [process.execPath, cli, "status", "--watch", "--interval", "600000"],
      {
        env: { ...process.env, SPOTUIFY_RUNTIME_DIR: control.directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(
      "Nothing is playing.",
    );
    child.kill("SIGINT");
    const exitCode = await Promise.race([
      child.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1_500),
      ),
    ]);
    if (exitCode === "timeout") child.kill();
    expect(exitCode).toBe(ExitCode.interrupted);
    reader.releaseLock();
  });

  test("interrupts a stalled in-flight watch request with one SIGINT", async () => {
    const control = await paths();
    let markRequested: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    server = await startControlServer(
      (method) => {
        if (method !== "status") throw new Error("unexpected method");
        markRequested?.();
        return new Promise<never>(() => {});
      },
      { paths: control },
    );
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = Bun.spawn(
      [process.execPath, cli, "status", "--watch", "--interval", "600000"],
      {
        env: { ...process.env, SPOTUIFY_RUNTIME_DIR: control.directory },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await requested;
    child.kill("SIGINT");
    const exitCode = await Promise.race([
      child.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1_500),
      ),
    ]);
    if (exitCode === "timeout") child.kill();
    expect(exitCode).toBe(ExitCode.interrupted);
  });
});
