import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  artifactName,
  assertNativeHost,
  MACOS_DEPLOYMENT_TARGET,
  productVersion,
  REPO_ROOT,
  releaseTarget,
  run,
  STAGE_DIR,
} from "./release-config.ts";

const target = releaseTarget();
assertNativeHost(target);
const version = await productVersion();
const name = artifactName(version, target);
const stage = resolve(STAGE_DIR, name);
const cargoTarget = resolve(REPO_ROOT, "dist", "cargo-target", target.id);
const bunWorkDirectory = resolve(REPO_ROOT, "dist", "bun-work", target.id);
const mainExecutable = resolve(stage, "spotuify");
const engineExecutable = resolve(stage, "spotuify-engine");

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

await run(
  [
    "cargo",
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    resolve(REPO_ROOT, "native", "Cargo.toml"),
  ],
  {
    env: {
      CARGO_TARGET_DIR: cargoTarget,
      ...(target.platform === "darwin"
        ? { MACOSX_DEPLOYMENT_TARGET: MACOS_DEPLOYMENT_TARGET }
        : {}),
    },
  },
);

await rm(bunWorkDirectory, { recursive: true, force: true });
await mkdir(bunWorkDirectory, { recursive: true });
const originalWorkingDirectory = process.cwd();
try {
  process.chdir(bunWorkDirectory);
  const build = await Bun.build({
    entrypoints: [resolve(REPO_ROOT, "src", "cli.ts")],
    define: {
      SPOTUIFY_STANDALONE: "true",
    },
    compile: {
      target: target.bunTarget,
      outfile: mainExecutable,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error(`failed to compile ${target.id} executable`);
  }
} finally {
  process.chdir(originalWorkingDirectory);
  await rm(bunWorkDirectory, { recursive: true, force: true });
}

await copyFile(resolve(cargoTarget, "release", "spotuify-engine"), engineExecutable);
await chmod(mainExecutable, 0o755);
await chmod(engineExecutable, 0o755);

console.log(`staged ${name} in ${stage}`);
