import { chmod, copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import {
  artifactName,
  buildVersion,
  releaseTarget,
  STAGE_DIR,
  type ReleaseTarget,
} from "./release-config.ts";
import {
  NPM_DIST_DIR,
  NPM_LAUNCHER,
  NPM_ROOT_PACKAGE,
  NPM_STAGE_DIR,
  npmPackageExecutableNames,
  npmPackageTarballName,
  npmPlatformManifest,
  npmPlatformPackage,
  npmRootManifest,
} from "./npm-packages.ts";

const argument = process.argv[2];
const version = await buildVersion();

async function createPackage(
  name: string,
  manifest: object,
  files: ReadonlyArray<{ source: string; destination: string; executable?: boolean }>,
): Promise<void> {
  const stage = resolve(NPM_STAGE_DIR, name);
  const tarball = resolve(NPM_DIST_DIR, npmPackageTarballName(name, version));

  await rm(stage, { recursive: true, force: true });
  await rm(tarball, { force: true });
  await mkdir(resolve(stage, "bin"), { recursive: true });
  await Bun.write(resolve(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const file of files) {
    const destination = resolve(stage, file.destination);
    await copyFile(file.source, destination);
    if (file.executable === true && process.platform !== "win32") {
      await chmod(destination, 0o755);
    }
  }

  await mkdir(NPM_DIST_DIR, { recursive: true });
  console.log(`$ npm pack --ignore-scripts --pack-destination ${NPM_DIST_DIR}`);
  await $`npm pack --ignore-scripts --pack-destination ${NPM_DIST_DIR}`
    .cwd(stage)
    .env({
      ...Bun.env,
      NPM_CONFIG_CACHE: resolve(NPM_DIST_DIR, "cache"),
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    });

  const metadata = await stat(tarball);
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`npm did not create ${tarball}`);
  }
  console.log(`created ${tarball}`);
}

async function createPlatformPackage(target: ReleaseTarget): Promise<void> {
  const packageMetadata = npmPlatformPackage(target);
  const releaseStage = resolve(STAGE_DIR, artifactName(version, target));
  const [mainExecutable, engineExecutable] = npmPackageExecutableNames(target);

  await createPackage(packageMetadata.name, npmPlatformManifest(version, target), [
    {
      source: resolve(releaseStage, mainExecutable),
      destination: join("bin", mainExecutable),
      executable: target.platform !== "win32",
    },
    {
      source: resolve(releaseStage, engineExecutable),
      destination: join("bin", engineExecutable),
      executable: target.platform !== "win32",
    },
  ]);
}

if (argument === "root") {
  await createPackage(NPM_ROOT_PACKAGE, npmRootManifest(version), [
    {
      source: NPM_LAUNCHER,
      destination: join("bin", "spotuify.cjs"),
      executable: true,
    },
  ]);
} else {
  await createPlatformPackage(releaseTarget(argument));
}
