import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const rootPackage = await Bun.file(resolve(repoRoot, "package.json")).json();
const expectedBunVersion = (
  await Bun.file(resolve(import.meta.dir, "bun-version.txt")).text()
).trim();
if (rootPackage.packageManager !== `bun@${expectedBunVersion}`) {
  throw new Error(
    `packageManager is ${rootPackage.packageManager}; update the vendored Bun license and bun-version.txt`,
  );
}

interface PackageMetadata {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface Component {
  name: string;
  version: string;
  license: string;
  text: string;
}

const components = new Map<string, Component>();
const visited = new Set<string>();
const allowedLicenses = new Set(["Apache-2.0", "BSD-3-Clause", "MIT"]);
const platformPackageFamilies = new Map([
  ["@opentui/core-", "@opentui/core platform binary packages"],
  ["@typescript/typescript-", "@typescript/typescript platform binary packages"],
]);

const sharedLicenseSources = new Map([
  ["react-devtools-core", resolve(repoRoot, "node_modules", "react")],
]);

function platformPackageFamily(packageName: string): string | null {
  for (const [prefix, displayName] of platformPackageFamilies) {
    if (packageName.startsWith(prefix)) return displayName;
  }
  return null;
}

async function licenseText(packageName: string, directory: string): Promise<string> {
  const candidates = (await readdir(directory))
    .filter((file) => /^(license|copying|notice)(?:[.-].*)?$/i.test(file))
    .sort((left, right) => {
      const leftLicense = /^license/i.test(left) ? 0 : 1;
      const rightLicense = /^license/i.test(right) ? 0 : 1;
      return leftLicense - rightLicense || left.localeCompare(right);
    });
  const file = candidates[0];
  if (file === undefined) {
    const sharedSource = sharedLicenseSources.get(packageName);
    if (sharedSource !== undefined) return licenseText(packageName, sharedSource);
    throw new Error(`no license file found in ${directory}`);
  }
  return (await Bun.file(resolve(directory, file)).text()).trim();
}

function packageDirectory(packageName: string, fromDirectory: string): string | null {
  const require = createRequire(resolve(fromDirectory, "package.json"));
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    try {
      let directory = dirname(require.resolve(packageName));
      while (directory !== dirname(directory)) {
        const metadata = Bun.file(resolve(directory, "package.json"));
        if (metadata.size > 0) return directory;
        directory = dirname(directory);
      }
      return null;
    } catch {
      return null;
    }
  }
}

async function visit(
  packageName: string,
  fromDirectory: string,
  optional = false,
): Promise<void> {
  const directory = packageDirectory(packageName, fromDirectory);
  if (directory === null) {
    if (optional || platformPackageFamily(packageName) !== null) return;
    throw new Error(`production dependency ${packageName} is not installed`);
  }
  if (visited.has(directory)) return;
  visited.add(directory);
  const packageFile = Bun.file(resolve(directory, "package.json"));
  const metadata = (await packageFile.json()) as PackageMetadata;
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.version !== "string" ||
    typeof metadata.license !== "string"
  ) {
    throw new Error(`${packageName} is missing name, version, or license metadata`);
  }
  if (!allowedLicenses.has(metadata.license)) {
    throw new Error(`${metadata.name} uses unapproved JavaScript license ${metadata.license}`);
  }
  const displayName = platformPackageFamily(metadata.name) ?? metadata.name;
  components.set(`${displayName}@${metadata.version}`, {
    name: displayName,
    version: metadata.version,
    license: metadata.license,
    text: await licenseText(metadata.name, directory),
  });

  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    await visit(dependency, directory);
  }
  for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
    const family = platformPackageFamily(dependency);
    if (family !== null) {
      components.set(`${family}@${metadata.version}`, {
        name: family,
        version: metadata.version,
        license: metadata.license,
        text: await licenseText(metadata.name, directory),
      });
    } else {
      await visit(dependency, directory, true);
    }
  }
  for (const dependency of Object.keys(metadata.peerDependencies ?? {})) {
    await visit(
      dependency,
      directory,
      metadata.peerDependenciesMeta?.[dependency]?.optional === true,
    );
  }
}

for (const dependency of Object.keys(rootPackage.dependencies ?? {}).sort()) {
  await visit(dependency, repoRoot);
}

const bunLicense = (
  await Bun.file(resolve(import.meta.dir, "bun-LICENSE.md")).text()
).trim();
const groups = Map.groupBy(
  [...components.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  ),
  (component) => `${component.license}\0${component.text}`,
);

const sections = [
  "===============================================================================",
  `Bun runtime ${expectedBunVersion}`,
  "",
  bunLicense,
];
for (const [key, group] of [...groups.entries()].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  const [license, text] = key.split("\0");
  sections.push(
    "",
    "===============================================================================",
    `${license} JavaScript packages`,
    "",
    "Used by:",
    ...group.map((component) => `- ${component.name} ${component.version}`),
    "",
    text ?? "",
  );
}

console.log(sections.join("\n"));
