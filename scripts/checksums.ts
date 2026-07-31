import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  archiveName,
  buildVersion,
  DIST_DIR,
  RELEASE_TARGETS,
} from "./release-config.ts";

const version = await buildVersion();
const expected = Object.values(RELEASE_TARGETS)
  .map((target) => archiveName(version, target))
  .sort();
const actual = (await readdir(DIST_DIR))
  .filter(
    (file) =>
      file.startsWith(`spotuify-v${version}-`) &&
      (file.endsWith(".tar.gz") || file.endsWith(".zip")),
  )
  .sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(
    `expected release archives ${expected.join(", ")}, found ${actual.join(", ") || "none"}`,
  );
}

const lines: string[] = [];
for (const file of actual) {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(resolve(DIST_DIR, file)).stream()) {
    hash.update(chunk);
  }
  lines.push(`${hash.digest("hex")}  ${file}`);
}
await Bun.write(resolve(DIST_DIR, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`created ${resolve(DIST_DIR, "SHA256SUMS")}`);
