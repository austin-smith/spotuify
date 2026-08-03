import { resolve } from "node:path";
import { buildVersion, DIST_DIR } from "./release-config.ts";
import {
  homebrewFormula,
  homebrewMetadata,
} from "./homebrew-formula.ts";

const version = await buildVersion();
const checksumLines = (
  await Bun.file(resolve(DIST_DIR, "SHA256SUMS")).text()
).trim().split("\n");
const checksums = new Map(
  checksumLines.map((line) => {
    const match =
      /^([0-9a-f]{64})  (install\.(?:ps1|sh)|\S+\.(?:tar\.gz|zip)|spotuify-v\S+-standalone-(?:spotuify|engine|launcher)(?:\.exe)?)$/.exec(line);
    if (match === null) throw new Error(`invalid checksum line: ${line}`);
    return [match[2]!, match[1]!] as const;
  }),
);

const formula = homebrewFormula(version, checksums);

const output = resolve(DIST_DIR, "spotuify.rb");
const metadataOutput = resolve(DIST_DIR, "spotuify.json");
await Promise.all([
  Bun.write(output, formula),
  Bun.write(metadataOutput, homebrewMetadata(version)),
]);
console.log(`created ${output} and ${metadataOutput}`);
