const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isSemanticVersion(value: unknown): value is string {
  return typeof value === "string" && STRICT_SEMVER.test(value);
}

export function isStableVersion(value: unknown): value is string {
  return isSemanticVersion(value) && !value.includes("-") && !value.includes("+");
}

export function compareSemanticVersions(left: string, right: string): -1 | 0 | 1 {
  if (!isSemanticVersion(left) || !isSemanticVersion(right)) {
    throw new Error("semantic version comparison requires two valid versions");
  }
  return Bun.semver.order(left, right);
}

export function prereleaseIdentifiers(version: string): string[] | null {
  if (!isSemanticVersion(version)) throw new Error(`invalid semantic version ${version}`);
  const withoutBuild = version.split("+", 1)[0]!;
  const separator = withoutBuild.indexOf("-");
  return separator === -1 ? null : withoutBuild.slice(separator + 1).split(".");
}
