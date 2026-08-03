import { resolve } from "node:path";
import { buildArtifacts } from "./build-artifacts.ts";
import {
  artifactName,
  assertNativeHost,
  buildVersion,
  REPO_ROOT,
  releaseTarget,
  STANDALONE_STAGE_DIR,
  STAGE_DIR,
} from "./release-config.ts";

const target = releaseTarget();
assertNativeHost(target);
const version = await buildVersion();
const name = artifactName(version, target);
const stage = resolve(STAGE_DIR, name);

await buildArtifacts({
  bunWorkDirectory: resolve(REPO_ROOT, "dist", "bun-work", target.id),
  cargoTargetDirectory: resolve(REPO_ROOT, "dist", "cargo-target", target.id),
  stageDirectory: stage,
  target,
  version,
  ...(target.platform === "win32"
    ? { windowsLauncherDirectory: resolve(STANDALONE_STAGE_DIR, name) }
    : {}),
});

console.log(`staged ${name} in ${stage}`);
