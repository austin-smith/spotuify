import { canaryVersion, productVersion } from "./release-config.ts";

const runNumber = process.argv[2];
const runCreatedAt = process.argv[3];

if (runNumber === undefined || runCreatedAt === undefined) {
  throw new Error("usage: canary-version <github-run-number> <workflow-created-at>");
}

console.log(canaryVersion(await productVersion(), runNumber, runCreatedAt));
