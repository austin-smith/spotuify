import { resolve } from "node:path";
import { buildVersion, DIST_DIR } from "./release-config.ts";
import { homebrewFormula } from "./homebrew-formula.ts";

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
await Bun.write(output, formula);
console.log(`created ${output}`);
