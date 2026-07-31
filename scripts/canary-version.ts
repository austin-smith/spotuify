import { canaryVersion, productVersion } from "./release-config.ts";

const runNumber = process.argv[2];
const commitSha = process.argv[3];

if (runNumber === undefined || commitSha === undefined) {
  throw new Error("usage: canary-version <github-run-number> <git-commit-sha>");
}

console.log(canaryVersion(await productVersion(), runNumber, commitSha));
