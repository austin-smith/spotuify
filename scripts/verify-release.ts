import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  archiveName,
  artifactName,
  assertNativeHost,
  buildVersion,
  DIST_DIR,
  releaseExecutableNames,
  releaseTarget,
  run,
} from "./release-config.ts";
import { softwareLicenses } from "../src/licenses.ts";

const target = releaseTarget();
assertNativeHost(target);
const version = await buildVersion();
const name = artifactName(version, target);
const archive = resolve(DIST_DIR, archiveName(version, target));
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
  const expectedEntries = [...releaseExecutableNames(target)].sort();
  const expectedMembers = [`${name}/`, ...expectedEntries.map((file) => `${name}/${file}`)].sort();
  const actualMembers = (await output(["tar", "-tf", archive])).split("\n").sort();
  if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) {
    throw new Error(`archive contains unexpected members: ${actualMembers.join(", ")}`);
  }
  await run(["tar", "-xf", archive, "-C", temporary]);

  const root = resolve(temporary, name);
  const actualEntries = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: root }))).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(
      `unexpected archive contents: expected ${expectedEntries.join(", ")}, ` +
        `found ${actualEntries.join(", ")}`,
    );
  }

  const [mainName, engineName] = releaseExecutableNames(target);
  const executable = resolve(root, mainName);
  const engine = resolve(root, engineName);
  const expectedLicenses = (await softwareLicenses()).trim();
  if (target.platform !== "win32") {
    await chmod(executable, 0o755);
    await chmod(engine, 0o755);
  }
  const [mainVersion, engineVersion, licenses] = await Promise.all([
    output([executable, "--version"]),
    output([engine, "--version"]),
    output([executable, "licenses"]),
  ]);
  if (mainVersion !== `spotuify ${version}`) {
    throw new Error(`main executable reported ${JSON.stringify(mainVersion)}`);
  }
  if (engineVersion !== `spotuify-engine ${version}`) {
    throw new Error(`engine executable reported ${JSON.stringify(engineVersion)}`);
  }
  if (licenses !== expectedLicenses) {
    throw new Error("main executable reported unexpected software licenses");
  }
  console.log(`verified ${archive}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
