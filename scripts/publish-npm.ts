import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { productVersion, REPOSITORY_URL, run } from "./release-config.ts";
import {
  NPM_DIST_DIR,
  NPM_PACKAGE_NAMES,
  npmPackageTarballName,
} from "./npm-packages.ts";

interface RegistryMetadata {
  repository?: string | { url?: string };
  versions?: Record<string, { repository?: string | { url?: string } }>;
}

const EXPECTED_REPOSITORY = `${REPOSITORY_URL}.git`;

async function registryMetadata(name: string): Promise<RegistryMetadata | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${name}`);
  }
  return (await response.json()) as RegistryMetadata;
}

function repositoryUrl(value: RegistryMetadata["repository"]): string | undefined {
  return typeof value === "string" ? value : value?.url;
}

function normalizedRepository(value: string | undefined): string | undefined {
  return value?.replace(/^git\+/, "");
}

export function assertOwnedPackage(name: string, metadata: RegistryMetadata): void {
  const repository =
    repositoryUrl(metadata.repository) ??
    Object.values(metadata.versions ?? {})
      .map((version) => repositoryUrl(version.repository))
      .find((value) => value !== undefined);
  if (normalizedRepository(repository) !== EXPECTED_REPOSITORY) {
    throw new Error(
      `${name} already exists with repository ${JSON.stringify(repository)}; ` +
        `expected ${EXPECTED_REPOSITORY}`,
    );
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const version = await productVersion();
  const metadata = await Promise.all(
    NPM_PACKAGE_NAMES.map(async (name) => [name, await registryMetadata(name)] as const),
  );
  const missing = metadata.filter(([, value]) => value === null).map(([name]) => name);

  if (missing.length === NPM_PACKAGE_NAMES.length) {
    const commands = NPM_PACKAGE_NAMES.map(
      (name) => `npm publish ${npmPackageTarballName(name, version)} --access public`,
    ).join("\n");
    const message = [
      "npm bootstrap required",
      "",
      "Download the npm-packages workflow artifact and publish these packages once:",
      "",
      "```sh",
      commands,
      "```",
      "",
      "Then configure release.yml as the trusted GitHub Actions publisher for every package.",
    ].join("\n");
    console.log(message);
    const summary = Bun.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined) await appendFile(summary, `## ${message}\n`);
    return;
  }

  if (missing.length > 0) {
    throw new Error(
      `npm bootstrap is incomplete; manually publish the missing packages: ${missing.join(", ")}`,
    );
  }

  for (const [name, value] of metadata) {
    if (value === null) throw new Error(`missing npm metadata for ${name}`);
    assertOwnedPackage(name, value);
    if (value.versions?.[version] !== undefined) {
      console.log(`${name}@${version} is already published`);
      continue;
    }
    if (checkOnly) {
      console.log(`would publish ${name}@${version}`);
      continue;
    }
    await run([
      "npm",
      "publish",
      resolve(NPM_DIST_DIR, npmPackageTarballName(name, version)),
      "--access",
      "public",
      "--ignore-scripts",
    ]);
  }
}

if (import.meta.main) await main();
