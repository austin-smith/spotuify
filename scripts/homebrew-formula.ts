import {
  artifactName,
  PRODUCT_DESCRIPTION,
  RELEASE_TARGETS,
  REPOSITORY_URL,
} from "./release-config.ts";

export function homebrewFormula(
  version: string,
  checksums: ReadonlyMap<string, string>,
): string {
  function source(targetName: keyof typeof RELEASE_TARGETS): string {
    const target = RELEASE_TARGETS[targetName];
    const filename = `${artifactName(version, target)}.tar.gz`;
    const checksum = checksums.get(filename);
    if (checksum === undefined) throw new Error(`missing checksum for ${filename}`);
    return [
      `  url "${REPOSITORY_URL}/releases/download/v${version}/${filename}"`,
      `  sha256 "${checksum}"`,
    ].join("\n");
  }

  return `class Spotuify < Formula
  desc "${PRODUCT_DESCRIPTION}"
  homepage "${REPOSITORY_URL}"
  version "${version}"
${source("darwin-arm64")}
  license "MIT"

  depends_on macos: :ventura
  depends_on arch: :arm64

  def install
    libexec.install "spotuify", "spotuify-engine"
    (bin/"spotuify").write_env_script libexec/"spotuify", SPOTUIFY_INSTALL_SOURCE: "homebrew"
  end

  test do
    assert_match "spotuify #{version}", shell_output("#{bin}/spotuify --version")
    assert_match "spotuify-engine #{version}", shell_output("#{libexec}/spotuify-engine --version")
    assert_match "spotuify third-party software notices", shell_output("#{bin}/spotuify licenses")
  end
end
`;
}
