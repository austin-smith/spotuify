import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Atomically replace a private cache file.
 *
 * The temporary file is created owner-only in the destination directory, flushed before rename,
 * and never exposes a partially written credential or account cache at the final path.
 */
export async function writePrivateFileAtomic(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let replaced = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    replaced = true;
  } finally {
    if (!replaced) await unlink(temporaryPath).catch(() => {});
  }
}
