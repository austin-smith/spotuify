declare const SPOTUIFY_STANDALONE: boolean | undefined;

export type InstallSource = "npm" | "homebrew" | "direct" | "source";

export function isStandaloneBuild(): boolean {
  return typeof SPOTUIFY_STANDALONE !== "undefined" && SPOTUIFY_STANDALONE === true;
}

/**
 * Distribution wrappers stamp the source explicitly. Filesystem paths are not reliable evidence:
 * both npm prefixes and Homebrew prefixes are configurable, and the release binary is also
 * available as a direct download.
 */
export function installSource(
  value = process.env["SPOTUIFY_INSTALL_SOURCE"],
  standalone = isStandaloneBuild(),
): InstallSource {
  if (value === "npm" || value === "homebrew") return value;
  return standalone ? "direct" : "source";
}
