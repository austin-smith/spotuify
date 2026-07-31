import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import {
  archiveName,
  artifactName,
  buildVersion,
  DIST_DIR,
  releaseExecutableNames,
  releaseTarget,
  STAGE_DIR,
} from "./release-config.ts";

const target = releaseTarget();
const version = await buildVersion();
const name = artifactName(version, target);
const stage = resolve(STAGE_DIR, name);
const archive = resolve(DIST_DIR, archiveName(version, target));
const expectedFiles = releaseExecutableNames(target);

for (const file of expectedFiles) {
  const metadata = await stat(resolve(stage, file));
  if (!metadata.isFile()) throw new Error(`${stage}/${file} is not a regular file`);
}

async function sourceDateEpoch(): Promise<number> {
  if (Bun.env.SOURCE_DATE_EPOCH !== undefined) {
    return Number.parseInt(Bun.env.SOURCE_DATE_EPOCH, 10);
  }
  const process = Bun.spawn(["git", "show", "-s", "--format=%ct", "HEAD"], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error("could not read the release commit timestamp");
  return Number.parseInt(stdout.trim(), 10);
}

const sourceDate = await sourceDateEpoch();
if (!Number.isSafeInteger(sourceDate) || sourceDate < 0) {
  throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
}
for (const path of [stage, ...expectedFiles.map((file) => resolve(stage, file))]) {
  await utimes(path, sourceDate, sourceDate);
}

await mkdir(DIST_DIR, { recursive: true });
await rm(archive, { force: true });

if (target.archiveExtension === "zip") {
  const zip = Bun.spawn(["tar", "-a", "-cf", archive, "-C", STAGE_DIR, name], {
    env: { ...Bun.env, COPYFILE_DISABLE: "1" },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await zip.exited;
  if (exitCode !== 0) {
    await rm(archive, { force: true });
    throw new Error(`zip archive creation failed with status ${exitCode}`);
  }
} else {
  const tar = Bun.spawn(["tar", "-cf", "-", "-C", STAGE_DIR, name], {
    env: { ...Bun.env, COPYFILE_DISABLE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const gzip = Bun.spawn(["gzip", "-n", "-9"], {
    stdin: tar.stdout,
    stdout: Bun.file(archive),
    stderr: "inherit",
  });
  const [tarCode, gzipCode] = await Promise.all([tar.exited, gzip.exited]);
  if (tarCode !== 0 || gzipCode !== 0) {
    await rm(archive, { force: true });
    throw new Error(`archive creation failed: tar=${tarCode}, gzip=${gzipCode}`);
  }
}

console.log(`created ${archive}`);
