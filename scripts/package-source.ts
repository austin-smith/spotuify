import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildVersion,
  DIST_DIR,
  REPO_ROOT,
  sourceArchiveName,
} from "./release-config.ts";

const version = await buildVersion();
const filename = sourceArchiveName(version);
const archive = resolve(DIST_DIR, filename);
const prefix = filename.replace(/\.tar\.gz$/, "/");

await rm(archive, { force: true });

const gitArchive = Bun.spawn(
  ["git", "archive", "--format=tar", `--prefix=${prefix}`, "HEAD"],
  {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  },
);
const gzip = Bun.spawn(["gzip", "-n", "-9"], {
  stdin: gitArchive.stdout,
  stdout: Bun.file(archive),
  stderr: "inherit",
});
const [archiveExit, gzipExit] = await Promise.all([
  gitArchive.exited,
  gzip.exited,
]);
if (archiveExit !== 0 || gzipExit !== 0) {
  await rm(archive, { force: true });
  throw new Error(
    `source archive creation failed: git=${archiveExit}, gzip=${gzipExit}`,
  );
}

console.log(`created ${archive}`);
