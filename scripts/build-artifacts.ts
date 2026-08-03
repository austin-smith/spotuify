import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executableName,
  MACOS_DEPLOYMENT_TARGET,
  REPO_ROOT,
  run,
  type ReleaseTarget,
} from "./release-config.ts";

interface BuildArtifactsOptions {
  readonly bunWorkDirectory: string;
  readonly cargoTargetDirectory: string;
  readonly stageDirectory: string;
  readonly target: ReleaseTarget;
  readonly version: string;
  readonly windowsLauncherDirectory?: string;
}

export async function buildArtifacts({
  bunWorkDirectory,
  cargoTargetDirectory,
  stageDirectory,
  target,
  version,
  windowsLauncherDirectory,
}: BuildArtifactsOptions): Promise<void> {
  const mainExecutable = resolve(
    stageDirectory,
    executableName("spotuify", target),
  );
  const engineExecutable = resolve(
    stageDirectory,
    executableName("spotuify-engine", target),
  );
  const [spotuifyLicense, thirdPartyNotices] = await Promise.all([
    Bun.file(resolve(REPO_ROOT, "LICENSE")).text(),
    Bun.file(resolve(REPO_ROOT, "THIRD_PARTY_NOTICES.txt")).text(),
  ]);

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });

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
        CARGO_TARGET_DIR: cargoTargetDirectory,
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
    resolve(
      cargoTargetDirectory,
      "release",
      executableName("spotuify-engine", target),
    ),
    engineExecutable,
  );
  if (target.platform === "win32") {
    if (windowsLauncherDirectory === undefined) {
      throw new Error("Windows builds require a launcher output directory");
    }
    await mkdir(windowsLauncherDirectory, { recursive: true });
    await copyFile(
      resolve(
        cargoTargetDirectory,
        "release",
        executableName("spotuify-launcher", target),
      ),
      resolve(
        windowsLauncherDirectory,
        executableName("spotuify-launcher", target),
      ),
    );
  } else {
    await chmod(mainExecutable, 0o755);
    await chmod(engineExecutable, 0o755);
  }
}
