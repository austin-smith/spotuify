import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  artifactName,
  assertNativeHost,
  buildVersion,
  executableName,
  MACOS_DEPLOYMENT_TARGET,
  REPO_ROOT,
  releaseTarget,
  run,
  STANDALONE_STAGE_DIR,
  STAGE_DIR,
} from "./release-config.ts";

const target = releaseTarget();
assertNativeHost(target);
const version = await buildVersion();
const name = artifactName(version, target);
const stage = resolve(STAGE_DIR, name);
const cargoTarget = resolve(REPO_ROOT, "dist", "cargo-target", target.id);
const bunWorkDirectory = resolve(REPO_ROOT, "dist", "bun-work", target.id);
const mainExecutable = resolve(stage, executableName("spotuify", target));
const engineExecutable = resolve(stage, executableName("spotuify-engine", target));
const [spotuifyLicense, thirdPartyNotices] = await Promise.all([
  Bun.file(resolve(REPO_ROOT, "LICENSE")).text(),
  Bun.file(resolve(REPO_ROOT, "THIRD_PARTY_NOTICES.txt")).text(),
]);

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
      SPOTUIFY_BUILD_VERSION: JSON.stringify(version),
      SPOTUIFY_LICENSE_TEXT: JSON.stringify(spotuifyLicense),
      SPOTUIFY_THIRD_PARTY_NOTICES_TEXT: JSON.stringify(thirdPartyNotices),
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

await copyFile(
  resolve(cargoTarget, "release", executableName("spotuify-engine", target)),
  engineExecutable,
);
if (target.platform === "win32") {
  const launcherDirectory = resolve(STANDALONE_STAGE_DIR, name);
  await mkdir(launcherDirectory, { recursive: true });
  await copyFile(
    resolve(cargoTarget, "release", executableName("spotuify-launcher", target)),
    resolve(launcherDirectory, executableName("spotuify-launcher", target)),
  );
}
if (target.platform !== "win32") {
  await chmod(mainExecutable, 0o755);
  await chmod(engineExecutable, 0o755);
}

console.log(`staged ${name} in ${stage}`);
