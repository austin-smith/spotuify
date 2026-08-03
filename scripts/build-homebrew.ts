import { resolve } from "node:path";
import { buildArtifacts } from "./build-artifacts.ts";
import {
  DIST_DIR,
  hostReleaseTarget,
  productVersion,
  REPO_ROOT,
} from "./release-config.ts";

const target = hostReleaseTarget();
const version = await productVersion({ requirePinnedPackageManager: false });
const stage = resolve(DIST_DIR, "homebrew-stage");

await buildArtifacts({
  bunWorkDirectory: resolve(DIST_DIR, "bun-work", "homebrew"),
  cargoTargetDirectory: resolve(DIST_DIR, "cargo-target", "homebrew"),
  stageDirectory: stage,
  target,
  version,
});

console.log(`staged Homebrew source build for ${target.id} in ${stage}`);
