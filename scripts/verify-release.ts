import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  artifactName,
  assertNativeHost,
  DIST_DIR,
  productVersion,
  releaseTarget,
  run,
} from "./release-config.ts";

const target = releaseTarget();
assertNativeHost(target);
const version = await productVersion();
const name = artifactName(version, target);
const archive = resolve(DIST_DIR, `${name}.tar.gz`);
const temporary = await mkdtemp(resolve(tmpdir(), "spotuify-release-"));

async function output(command: string[]): Promise<string> {
  const process = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  if (exitCode !== 0) throw new Error(`${command[0]} exited with status ${exitCode}`);
  return stdout.trim();
}

try {
  const metadata = await stat(archive);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`${archive} is empty`);
  const expectedMembers = [
    `${name}/`,
    `${name}/spotuify`,
    `${name}/spotuify-engine`,
  ].sort();
  const actualMembers = (await output(["tar", "-tzf", archive])).split("\n").sort();
  if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) {
    throw new Error(`archive contains unexpected members: ${actualMembers.join(", ")}`);
  }
  await run(["tar", "-xzf", archive, "-C", temporary]);

  const root = resolve(temporary, name);
  const expectedEntries = ["spotuify", "spotuify-engine"].sort();
  const actualEntries = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: root }))).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(
      `unexpected archive contents: expected ${expectedEntries.join(", ")}, ` +
        `found ${actualEntries.join(", ")}`,
    );
  }

  const executable = resolve(root, "spotuify");
  const engine = resolve(root, "spotuify-engine");
  await chmod(executable, 0o755);
  await chmod(engine, 0o755);
  const [mainVersion, engineVersion] = await Promise.all([
    output([executable, "--version"]),
    output([engine, "--version"]),
  ]);
  if (mainVersion !== `spotuify ${version}`) {
    throw new Error(`main executable reported ${JSON.stringify(mainVersion)}`);
  }
  if (engineVersion !== `spotuify-engine ${version}`) {
    throw new Error(`engine executable reported ${JSON.stringify(engineVersion)}`);
  }
  console.log(`verified ${archive}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
