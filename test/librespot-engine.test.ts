import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  authenticateEngine,
  engineRestartDelay,
  LibrespotEngine,
  NativePlaybackUnavailableError,
  parseEngineMessage,
  sidecarCandidatePaths,
} from "../src/engine/librespot.ts";

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(5);
  }
}

describe("librespot sidecar protocol", () => {
  test("uses the platform-specific native executable name", () => {
    expect(sidecarCandidatePaths("darwin", undefined).map((path) => basename(path))).toEqual(
      ["spotuify-engine", "spotuify-engine"],
    );
    expect(sidecarCandidatePaths("win32", undefined).map((path) => basename(path))).toEqual(
      ["spotuify-engine.exe", "spotuify-engine.exe"],
    );
  });

  test("prefers an explicit sidecar and then the freshly built debug artifact", () => {
    const configured = join(tmpdir(), "configured-sidecar");
    const candidates = sidecarCandidatePaths(process.platform, configured);

    expect(candidates[0]).toBe(configured);
    expect(candidates[1]).toContain(`${join("native", "target", "debug")}`);
    expect(candidates[2]).toContain(`${join("native", "target", "release")}`);
  });

  test("delegates playback OAuth and cache ownership to the native engine", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-auth-test-"));
    const sidecar = join(directory, "fake-sidecar");
    const received = join(directory, "auth-config.json");
    const source = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const config = JSON.parse(await Bun.stdin.text());
writeFileSync(${JSON.stringify(received)}, JSON.stringify({
  args: process.argv.slice(2),
  config,
}));
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);

      await expect(
        authenticateEngine({ force: true, sidecarPath: sidecar }, 1_000),
      ).resolves.toBe("authorized");
      expect(await Bun.file(received).json()).toMatchObject({
        args: ["auth"],
        config: {
          cacheDir: expect.stringContaining("spotuify/librespot"),
          deviceName: "spotuify",
          force: true,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports native authentication failure and timeout distinctly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-auth-test-"));
    const failure = join(directory, "failure-sidecar");
    const silent = join(directory, "silent-sidecar");

    try {
      await Bun.write(
        failure,
        "#!/usr/bin/env bun\nawait Bun.stdin.text();\nprocess.exit(1);\n",
      );
      await Bun.write(silent, "#!/usr/bin/env bun\nsetInterval(() => {}, 1000);\n");
      await chmod(failure, 0o700);
      await chmod(silent, 0o700);

      await expect(
        authenticateEngine({ sidecarPath: failure }, 1_000),
      ).resolves.toBe("failed");
      await expect(
        authenticateEngine({ sidecarPath: silent }, 20),
      ).resolves.toBe("timed-out");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconnect backoff is bounded rather than an infinite login loop", () => {
    expect([0, 1, 2, 3].map((attempt) => engineRestartDelay(attempt))).toEqual([
      1_000,
      2_500,
      5_000,
      null,
    ]);
  });

  test("reports a non-executable sidecar as failed without rejecting start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;

    try {
      await Bun.write(sidecar, "#!/usr/bin/env bun\n");
      await chmod(sidecar, 0o600);
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
      });

      await expect(engine.start()).resolves.toBeUndefined();
      expect(engine.getStatus()).toMatchObject({
        state: "failed",
        reason: expect.stringContaining("could not launch playback engine"),
      });
    } finally {
      engine?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("contains a synchronous launch failure during a scheduled restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
import { chmodSync } from "node:fs";
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
setTimeout(() => {
  chmodSync(${JSON.stringify(sidecar)}, 0o600);
  process.exit(1);
}, 10);
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
        restartDelaysMs: [10],
        stableUptimeMs: 10_000,
      });

      await engine.start();
      await eventually(() => {
        const status = engine?.getStatus();
        return (
          status?.state === "failed" &&
          status.reason.includes("could not launch playback engine")
        );
      });

      expect(engine.getStatus()).toMatchObject({
        state: "failed",
        reason: expect.stringContaining("could not launch playback engine"),
      });
    } finally {
      engine?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restarts a previously ready crashed receiver and reports its lost active session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    const attempts = join(directory, "attempts");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const attemptsPath = ${JSON.stringify(attempts)};
const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) + 1 : 1;
writeFileSync(attemptsPath, String(attempt));
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
if (attempt === 1) {
  console.log(JSON.stringify({ type: "event", event: { name: "session_connected" } }));
  setTimeout(() => process.exit(1), 10);
} else {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line);
      if (message.command === "shutdown") {
        console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
        process.exit(0);
      }
    }
  });

}
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);

      const statuses: string[] = [];
      const events: string[] = [];
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
        restartDelaysMs: [10],
        stableUptimeMs: 10_000,
      });
      engine.onStatus((status) => statuses.push(status.state));
      engine.onEvent((event) => events.push(event.name));

      await engine.start();
      await eventually(() => statuses.filter((state) => state === "ready").length === 2);

      expect(events).toEqual(["session_connected", "session_disconnected"]);
      expect(await Bun.file(attempts).text()).toBe("2");
      expect(engine.getStatus().state).toBe("ready");
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes an active disconnect before a failed status hides its verified identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
console.log(JSON.stringify({ type: "event", event: { name: "session_connected" } }));
setTimeout(() => {
  console.log(JSON.stringify({ type: "status", state: "failed", reason: "session ended" }));
}, 10);
setInterval(() => {}, 1000);
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      const disconnects: Array<{
        status: string;
        deviceId?: string;
        accountId?: string;
      }> = [];
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
        restartDelaysMs: [],
      });
      engine.onEvent((event) => {
        if (event.name !== "session_disconnected") return;
        const status = engine!.getStatus();
        disconnects.push({
          status: status.state,
          ...(status.state === "ready"
            ? { deviceId: status.deviceId, accountId: status.accountId }
            : {}),
        });
      });

      await engine.start();
      await eventually(() => engine?.getStatus().state === "failed");
      await Bun.sleep(20);

      expect(disconnects).toEqual([
        {
          status: "ready",
          deviceId: "receiver",
          accountId: "account",
        },
      ]);
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replays startup events only after ready publishes the account identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "event", event: { name: "session_connected" } }));
console.log(JSON.stringify({
  type: "event",
  event: { name: "playing", uri: "spotify:track:one", position_ms: 1234 }
}));
console.log(JSON.stringify({
  type: "event",
  event: { name: "position_changed", uri: "spotify:track:one", position_ms: 2000 }
}));
console.log(JSON.stringify({
  type: "event",
  event: { name: "position_changed", uri: "spotify:track:one", position_ms: 3000 }
}));
setTimeout(() => {
  console.log(JSON.stringify({
    type: "status",
    state: "ready",
    device_id: "receiver",
    account_id: "account"
  }));
}, 10);
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.command === "shutdown") process.exit(0);
  }
});
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      const events: Array<{ name: string; status: string }> = [];
      const positions: number[] = [];
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
      });
      await engine.start();
      await eventually(() => engine?.getStatus().state === "ready");
      engine.onEvent((event) => {
        events.push({ name: event.name, status: engine!.getStatus().state });
        if (event.name === "position_changed") positions.push(event.position_ms);
      });
      await eventually(() => events.length === 3);

      expect(events).toEqual([
        { name: "session_connected", status: "ready" },
        { name: "playing", status: "ready" },
        { name: "position_changed", status: "ready" },
      ]);
      expect(positions).toEqual([3_000]);
      expect(engine.isActive()).toBe(true);
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("bounds silent startup and applies the cold-start retry budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
setInterval(() => {}, 1000);
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      const statuses: string[] = [];
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
        readinessTimeoutMs: 20,
        restartDelaysMs: [10],
      });
      engine.onStatus((status) => statuses.push(status.state));

      await engine.start();
      await eventually(
        () =>
          statuses.filter((status) => status === "starting").length >= 2 &&
          engine?.getStatus().state === "failed",
      );

      expect(statuses.filter((status) => status === "starting")).toHaveLength(2);
      expect(engine.getStatus()).toMatchObject({
        state: "failed",
        reason: expect.stringContaining("timed out"),
      });
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("retries a reported startup failure before first readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    const attempts = join(directory, "attempts");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const attemptsPath = ${JSON.stringify(attempts)};
const attempt = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) + 1 : 1;
writeFileSync(attemptsPath, String(attempt));
if (attempt === 1) {
  console.log(JSON.stringify({ type: "status", state: "failed", reason: "temporary connection failure" }));
  process.exit(1);
}
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.command === "shutdown") process.exit(0);
  }
});
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
        restartDelaysMs: [10],
      });

      await engine.start();
      await eventually(() => engine?.getStatus().state === "ready");

      expect(await Bun.file(attempts).text()).toBe("2");
      expect(engine.getStatus().state).toBe("ready");
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("turns a typed no-op play response into a caller-visible rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.command === "play") {
      console.log(JSON.stringify({
        type: "response",
        id: message.id,
        ok: true,
        data: { kind: "play_unavailable", reason: "nothing is available to resume" }
      }));
    } else if (message.command === "shutdown") {
      console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
      process.exit(0);
    }
  }
});
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
      });
      await engine.start();
      await eventually(() => engine?.getStatus().state === "ready");

      await expect(engine.play()).rejects.toBeInstanceOf(NativePlaybackUnavailableError);
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sends explicit shuffle and repeat modes with every native load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    const received = join(directory, "load-command.json");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.command === "load") {
      writeFileSync(${JSON.stringify(received)}, JSON.stringify(message));
      console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
    } else if (message.command === "shutdown") {
      console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
      process.exit(0);
    }
  }
});
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
      });
      await engine.start();
      await eventually(() => engine?.getStatus().state === "ready");

      await engine.load({
        contextUri: "spotify:album:one",
        offset: 3,
        shuffle: true,
        repeat: "track",
      });

      expect(await Bun.file(received).json()).toMatchObject({
        command: "load",
        context_uri: "spotify:album:one",
        offset: 3,
        shuffle: true,
        repeat: "track",
      });
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serializes stateful commands before starting their acknowledgement timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    let engine: LibrespotEngine | null = null;
    const source = `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
let buffered = "";
let applying = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.command === "pause") {
      if (applying) {
        console.log(JSON.stringify({
          type: "response",
          id: message.id,
          ok: false,
          error: "received overlapping stateful command"
        }));
        continue;
      }
      applying = true;
      setTimeout(() => {
        applying = false;
        console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
      }, 25);
    } else if (message.command === "shutdown") {
      console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
      process.exit(0);
    }
  }
});
`;

    try {
      await Bun.write(sidecar, source);
      await chmod(sidecar, 0o700);
      engine = new LibrespotEngine("spotuify-test", {
        sidecarPath: sidecar,
      });
      await engine.start();
      await eventually(() => engine?.getStatus().state === "ready");

      await Promise.all([engine.pause(), engine.pause()]);
    } finally {
      engine?.stop();
      await Bun.sleep(20);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a graceful sidecar exit does not hold the parent for the forced-kill window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotuify-engine-test-"));
    const sidecar = join(directory, "fake-sidecar");
    const harness = join(directory, "shutdown-harness.ts");
    const engineModule = new URL("../src/engine/librespot.ts", import.meta.url).pathname;
    const sidecarSource = `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "status", state: "ready", device_id: "receiver", account_id: "account" }));
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.command === "shutdown") {
      console.log(JSON.stringify({ type: "response", id: message.id, ok: true }));
      process.exit(0);
    }
  }
});
`;
    const harnessSource = `
import { LibrespotEngine } from ${JSON.stringify(engineModule)};
const engine = new LibrespotEngine("spotuify-test", {
  sidecarPath: ${JSON.stringify(sidecar)},
});
await engine.start();
const deadline = performance.now() + 1_000;
while (engine.getStatus().state !== "ready") {
  if (performance.now() >= deadline) throw new Error("sidecar did not become ready");
  await Bun.sleep(5);
}
engine.stop();
`;

    try {
      await Bun.write(sidecar, sidecarSource);
      await chmod(sidecar, 0o700);
      await Bun.write(harness, harnessSource);

      const startedAt = performance.now();
      const child = Bun.spawn([process.execPath, harness], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await child.exited;
      const elapsed = performance.now() - startedAt;
      const stderr = await new Response(child.stderr).text();

      expect(exitCode, stderr).toBe(0);
      expect(elapsed).toBeLessThan(1_500);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts a ready status only with concrete device and account ids", () => {
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "status",
          state: "ready",
          device_id: "receiver-id",
          account_id: "account-id",
        }),
      ),
    ).toEqual({
      type: "status",
      state: "ready",
      device_id: "receiver-id",
      account_id: "account-id",
    });
    expect(parseEngineMessage(JSON.stringify({ type: "status", state: "ready" }))).toBeNull();
    expect(
      parseEngineMessage(
        JSON.stringify({ type: "status", state: "ready", device_id: "receiver-id" }),
      ),
    ).toBeNull();
  });

  test("accepts command acknowledgements and rejects unsafe ids", () => {
    expect(
      parseEngineMessage(JSON.stringify({ type: "response", id: 4, ok: false, error: "nope" })),
    ).toEqual({ type: "response", id: 4, ok: false, error: "nope" });
    expect(
      parseEngineMessage(JSON.stringify({ type: "response", id: -1, ok: true })),
    ).toBeNull();
  });

  test("preserves structured native track metadata", () => {
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "event",
          event: {
            name: "track_changed",
            uri: "spotify:episode:one",
            media_type: "episode",
            id: "one",
            title: "Episode",
            duration_ms: 1234,
            artists: [],
            album: null,
            show: "Show",
            covers: [{ url: "https://image", width: 640, height: 640 }],
          },
        }),
      ),
    ).toEqual({
      type: "event",
      event: {
        name: "track_changed",
        uri: "spotify:episode:one",
        media_type: "episode",
        id: "one",
        title: "Episode",
        duration_ms: 1234,
        artists: [],
        show: "Show",
        covers: [{ url: "https://image", width: 640, height: 640 }],
      },
    });
  });

  test("accepts authoritative native position updates", () => {
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "event",
          event: {
            name: "position_changed",
            uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
            position_ms: 42_000,
          },
        }),
      ),
    ).toEqual({
      type: "event",
      event: {
        name: "position_changed",
        uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
        position_ms: 42_000,
      },
    });
  });

  test("accepts resolved track metadata on a command response", () => {
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "response",
          id: 5,
          ok: true,
          data: {
            kind: "track_metadata",
            album: {
              id: "album-id",
              name: "Album",
              uri: "spotify:album:album-id",
            },
          },
        }),
      ),
    ).toEqual({
      type: "response",
      id: 5,
      ok: true,
      data: {
        kind: "track_metadata",
        album: {
          id: "album-id",
          name: "Album",
          uri: "spotify:album:album-id",
        },
      },
    });
  });

  test("accepts a typed response when native play has no resumable state", () => {
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "response",
          id: 6,
          ok: true,
          data: {
            kind: "play_unavailable",
            reason: "nothing is available to resume",
          },
        }),
      ),
    ).toEqual({
      type: "response",
      id: 6,
      ok: true,
      data: {
        kind: "play_unavailable",
        reason: "nothing is available to resume",
      },
    });
  });

  test("rejects malformed and unknown messages at the process boundary", () => {
    expect(parseEngineMessage("not json")).toBeNull();
    expect(parseEngineMessage("{}")).toBeNull();
    expect(
      parseEngineMessage(JSON.stringify({ type: "event", event: { name: "surprise" } })),
    ).toBeNull();
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "event",
          event: { name: "volume_changed", percent: 101 },
        }),
      ),
    ).toBeNull();
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "event",
          event: {
            name: "track_changed",
            media_type: "track",
            uri: "spotify:track:one",
            title: "Track",
            duration_ms: 1000,
            artists: ["not structured"],
            covers: [],
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseEngineMessage(
        JSON.stringify({
          type: "event",
          event: {
            name: "track_changed",
            media_type: "track",
            uri: "spotify:track:one",
            title: "Track",
            duration_ms: 1000,
            artists: [],
            covers: ["https://image"],
          },
        }),
      ),
    ).toBeNull();
  });
});
