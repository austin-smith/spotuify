import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildVersion, REPOSITORY_URL, run } from "./release-config.ts";
import {
  NPM_DIST_DIR,
  NPM_PACKAGE_NAMES,
  NPM_ROOT_PACKAGE,
  npmPackageTarballName,
} from "./npm-packages.ts";

interface RegistryMetadata {
  "dist-tags"?: Record<string, string>;
  repository?: string | { url?: string };
  versions?: Record<string, { repository?: string | { url?: string } }>;
}

const EXPECTED_REPOSITORY = `${REPOSITORY_URL}.git`;
const NPM_DIST_TAGS = ["latest", "canary"] as const;
type NpmDistTag = (typeof NPM_DIST_TAGS)[number];

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

export function npmDistTag(args: string[]): NpmDistTag {
  const index = args.indexOf("--tag");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || !NPM_DIST_TAGS.includes(value as NpmDistTag)) {
    throw new Error(`--tag must be one of: ${NPM_DIST_TAGS.join(", ")}`);
  }
  return value as NpmDistTag;
}

export function canaryRunNumber(version: string): bigint {
  const match =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-canary\.([1-9]\d*)\.g[0-9a-f]{12}$/.exec(
      version,
    );
  if (match?.[1] === undefined) {
    throw new Error(`invalid canary version ${JSON.stringify(version)}`);
  }
  return BigInt(match[1]);
}

export function isStaleCanary(currentVersion: string, publishingVersion: string): boolean {
  const currentRun = canaryRunNumber(currentVersion);
  const publishingRun = canaryRunNumber(publishingVersion);
  if (currentRun === publishingRun && currentVersion !== publishingVersion) {
    throw new Error(
      `canary run ${publishingRun} is already associated with ${currentVersion}`,
    );
  }
  return currentRun > publishingRun;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const distTag = npmDistTag(process.argv.slice(2));
  const version = await buildVersion();
  const metadata = await Promise.all(
    NPM_PACKAGE_NAMES.map(async (name) => [name, await registryMetadata(name)] as const),
  );
  const missing = metadata.filter(([, value]) => value === null).map(([name]) => name);

  if (missing.length === NPM_PACKAGE_NAMES.length) {
    if (distTag === "canary") {
      const message =
        "Canary publication is skipped until the packages are bootstrapped by a stable release.";
      console.log(message);
      const summary = Bun.env.GITHUB_STEP_SUMMARY;
      if (summary !== undefined) await appendFile(summary, `## ${message}\n`);
      return;
    }
    const commands = NPM_PACKAGE_NAMES.map(
      (name) =>
        `npm publish ${npmPackageTarballName(name, version)} --access public --tag latest`,
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
  }

  if (distTag === "canary") {
    canaryRunNumber(version);
    const rootMetadata = metadata.find(([name]) => name === NPM_ROOT_PACKAGE)?.[1];
    if (rootMetadata === null || rootMetadata === undefined) {
      throw new Error(`missing npm metadata for ${NPM_ROOT_PACKAGE}`);
    }
    const currentVersion = rootMetadata["dist-tags"]?.canary;
    if (currentVersion !== undefined && isStaleCanary(currentVersion, version)) {
      const message =
        `Skipping stale ${version}; npm's canary channel already points to ${currentVersion}.`;
      console.log(message);
      const summary = Bun.env.GITHUB_STEP_SUMMARY;
      if (summary !== undefined) await appendFile(summary, `## ${message}\n`);
      return;
    }
  }

  for (const [name, value] of metadata) {
    if (value === null) throw new Error(`missing npm metadata for ${name}`);
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
      "--tag",
      distTag,
      "--ignore-scripts",
    ]);
  }
}

if (import.meta.main) await main();
