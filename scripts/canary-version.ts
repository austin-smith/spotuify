import { canaryVersion, productVersion } from "./release-config.ts";

const runNumber = process.argv[2];
const commitTimestamp = process.argv[3];

if (runNumber === undefined || commitTimestamp === undefined) {
  throw new Error("usage: canary-version <github-run-number> <git-commit-timestamp>");
}

console.log(canaryVersion(await productVersion(), runNumber, commitTimestamp));
