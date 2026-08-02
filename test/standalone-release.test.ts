import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSource,
  standaloneInstallation,
  type StandaloneInstallation,
} from "../src/distribution.ts";
import {
  installStandaloneUpdate,
  parseStandaloneManifest,
  type StandaloneFetcher,
  writeAllBytes,
} from "../src/standalone-release.ts";

let temporary: string | undefined;

afterEach(async () => {
  if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
  temporary = undefined;
});

function executable(version: string, engine = false): string {
  return `#!/bin/sh\n[ "\${1:-}" = "--version" ] && printf '${engine ? "spotuify-engine" : "spotuify"} ${version}\\n'\n`;
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function installation(version = "1.0.0"): Promise<StandaloneInstallation> {
  temporary = await mkdtemp(join(tmpdir(), "spotuify-standalone-update-"));
  const prefix = join(temporary, "prefix");
  const root = join(prefix, "share", "spotuify");
  const releaseName = `${version}-linux-x64`;
  const releaseDirectory = join(root, "releases", releaseName);
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(prefix, "libexec"), { recursive: true });
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(join(root, ".spotuify-install.json"), JSON.stringify({
    schema: 1,
    manager: "spotuify-installer",
    target: "linux-x64",
  }));
  await writeFile(join(releaseDirectory, "spotuify"), executable(version), { mode: 0o755 });
  await writeFile(join(releaseDirectory, "spotuify-engine"), executable(version, true), { mode: 0o755 });
  await symlink(releaseDirectory, join(root, "current"));
  await symlink(join(root, "current", "spotuify"), join(prefix, "bin", "spotuify"));
  await symlink(join(root, "current", "spotuify-engine"), join(prefix, "libexec", "spotuify-engine"));
  const canonicalRoot = await realpath(root);
  return {
    root: canonicalRoot,
    releaseDirectory: join(canonicalRoot, "releases", releaseName),
    releaseName,
    target: "linux-x64",
  };
}

function releaseFixture(version = "2.0.0") {
  const mainName = `spotuify-v${version}-linux-x64-standalone-spotuify`;
  const engineName = `spotuify-v${version}-linux-x64-standalone-engine`;
  const main = executable(version);
  const engine = executable(version, true);
  const manifest = `${digest(main)}  ${mainName}\n${digest(engine)}  ${engineName}\n`;
  const files = new Map([[mainName, main], [engineName, engine]]);
  const fetcher: StandaloneFetcher = async (input) => {
    const url = String(input);
    if (url.endsWith("/SHA256SUMS")) return new Response(manifest);
    const contents = files.get(url.slice(url.lastIndexOf("/") + 1));
    return contents === undefined
      ? new Response("missing", { status: 404 })
      : new Response(contents, { headers: { "content-length": String(contents.length) } });
  };
  return { engineName, fetcher, mainName, manifest };
}

describe("standalone release metadata", () => {
  test("requires one complete, target-specific component set", () => {
    const fixture = releaseFixture();
    expect(parseStandaloneManifest(fixture.manifest, "linux-x64")).toMatchObject({
      version: "2.0.0",
      main: { name: fixture.mainName },
      engine: { name: fixture.engineName },
    });
    expect(() => parseStandaloneManifest(`${fixture.manifest}${fixture.manifest}`, "linux-x64"))
      .toThrow("repeats");
    expect(() => parseStandaloneManifest("", "linux-x64")).toThrow("exactly one");
  });

  test("requires the verified launcher in a Windows component set", () => {
    const main = "spotuify-v2.0.0-windows-x64-standalone-spotuify.exe";
    const engine = "spotuify-v2.0.0-windows-x64-standalone-engine.exe";
    const launcher = "spotuify-v2.0.0-windows-x64-standalone-launcher.exe";
    const manifest = `${"a".repeat(64)}  ${main}\n${"b".repeat(64)}  ${engine}\n`;
    expect(() => parseStandaloneManifest(manifest, "windows-x64")).toThrow("verified launcher");
    expect(
      parseStandaloneManifest(`${manifest}${"c".repeat(64)}  ${launcher}\n`, "windows-x64"),
    ).toMatchObject({ launcher: { name: launcher } });
  });

  test("recognizes only a marker-owned active release", async () => {
    const managed = await installation();
    const detected = standaloneInstallation(
      join(managed.releaseDirectory, "spotuify"),
      "linux",
      "x64",
      managed.root,
    );
    expect(detected).toEqual(managed);
    expect(installSource(undefined, true, detected)).toBe("standalone");

    await rm(join(managed.root, "current"));
    await writeFile(join(managed.root, "current"), "not a symlink");
    expect(
      standaloneInstallation(join(managed.releaseDirectory, "spotuify"), "linux", "x64", managed.root),
    ).toBeUndefined();
  });
});

describe("standalone updater", () => {
  test("persists complete chunks when the filesystem reports short writes", async () => {
    const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const persisted: number[] = [];
    await writeAllBytes({
      async write(buffer, offset, length) {
        const bytesWritten = Math.min(2, length);
        persisted.push(...buffer.subarray(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    }, source);
    expect(persisted).toEqual([...source]);
  });

  test("stages, verifies, and atomically activates a new release", async () => {
    const managed = await installation();
    const fixture = releaseFixture();
    await installStandaloneUpdate(managed, "2.0.0", fixture.fetcher);

    expect(await realpath(join(managed.root, "current"))).toBe(
      await realpath(join(managed.root, "releases", "2.0.0-linux-x64")),
    );
    expect((await stat(join(managed.root, "releases", "2.0.0-linux-x64"))).mode & 0o777).toBe(
      0o755,
    );
    expect(await Bun.$`${join(temporary!, "prefix", "bin", "spotuify")} --version`.text()).toBe(
      "spotuify 2.0.0\n",
    );
    expect(await readFile(join(managed.releaseDirectory, "spotuify"), "utf8")).toContain("1.0.0");
  });

  test("preserves the active release when checksum verification fails", async () => {
    const managed = await installation();
    const fixture = releaseFixture();
    const badFetcher: StandaloneFetcher = async (input, init) => {
      const response = await fixture.fetcher(input, init);
      return String(input).endsWith(fixture.mainName) ? new Response("tampered") : response;
    };
    await expect(installStandaloneUpdate(managed, "2.0.0", badFetcher)).rejects.toThrow(
      "checksum verification failed",
    );
    expect(await realpath(join(managed.root, "current"))).toBe(await realpath(managed.releaseDirectory));
  });

  test("rolls back the active pointer when post-switch verification fails", async () => {
    const managed = await installation();
    const fixture = releaseFixture();
    await expect(
      installStandaloneUpdate(managed, "2.0.0", fixture.fetcher, async () => {
        throw new Error("simulated active command failure");
      }),
    ).rejects.toThrow("simulated active command failure");
    expect(await realpath(join(managed.root, "current"))).toBe(await realpath(managed.releaseDirectory));
  });

  test("does not downgrade after a newer concurrent update wins the lock", async () => {
    const managed = await installation();
    const newerDirectory = join(managed.root, "releases", "3.0.0-linux-x64");
    await mkdir(newerDirectory);
    await writeFile(join(newerDirectory, "spotuify"), executable("3.0.0"), { mode: 0o755 });
    await writeFile(join(newerDirectory, "spotuify-engine"), executable("3.0.0", true), {
      mode: 0o755,
    });
    await rm(join(managed.root, "current"));
    await symlink(newerDirectory, join(managed.root, "current"));

    const fixture = releaseFixture("2.0.0");
    const result = await installStandaloneUpdate(managed, "2.0.0", fixture.fetcher);
    expect(result).toEqual({ version: "3.0.0", changed: false });
    expect(await realpath(join(managed.root, "current"))).toBe(await realpath(newerDirectory));
  });

  test("refuses a concurrent managed installation", async () => {
    const managed = await installation();
    const fixture = releaseFixture();
    const lock = join(managed.root, ".install.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner"), `${process.pid}\ntest-owner\n`);
    await expect(installStandaloneUpdate(managed, "2.0.0", fixture.fetcher)).rejects.toThrow(
      "another Spotuify installation is running",
    );
  });

  test("reclaims a stale lock and releases only its replacement lock", async () => {
    const managed = await installation();
    const fixture = releaseFixture();
    const lock = join(managed.root, ".install.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner"), "2147483647\nstale-owner\n");
    await installStandaloneUpdate(managed, "2.0.0", fixture.fetcher);
    expect(await realpath(join(managed.root, "current"))).toBe(
      await realpath(join(managed.root, "releases", "2.0.0-linux-x64")),
    );
    await expect(readFile(join(lock, "owner"), "utf8")).rejects.toThrow();
  });

  test("treats an uninitialized lock as busy instead of deleting it", async () => {
    const managed = await installation();
    const fixture = releaseFixture();
    const lock = join(managed.root, ".install.lock");
    await mkdir(lock);
    await expect(installStandaloneUpdate(managed, "2.0.0", fixture.fetcher)).rejects.toThrow(
      "another Spotuify installation is running",
    );
  });
});
