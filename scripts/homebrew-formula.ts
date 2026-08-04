import {
  artifactName,
  RELEASE_TARGETS,
  REPOSITORY_URL,
} from "./release-config.ts";

export function homebrewFormula(
  version: string,
  checksums: ReadonlyMap<string, string>,
): string {
  function source(
    targetName: keyof typeof RELEASE_TARGETS,
    indentation: number,
  ): string {
    const target = RELEASE_TARGETS[targetName];
    const filename = `${artifactName(version, target)}.tar.gz`;
    const checksum = checksums.get(filename);
    if (checksum === undefined) throw new Error(`missing checksum for ${filename}`);
    const indent = " ".repeat(indentation);
    return [
      `${indent}url "${REPOSITORY_URL}/releases/download/v${version}/${filename}"`,
      `${indent}sha256 "${checksum}"`,
    ].join("\n");
  }

  return `class Spotuify < Formula
  desc "Spotify in your terminal"
  homepage "${REPOSITORY_URL}"
  version "${version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
${source("darwin-arm64", 6)}
    end
    depends_on arch: :arm64
    depends_on macos: :ventura
  end

  on_linux do
    if Hardware::CPU.arm?
${source("linux-arm64", 6)}
    else
${source("linux-x64", 6)}
    end
    depends_on "patchelf" => :build
    depends_on "alsa-lib"
  end

  def install
    libexec.install "spotuify", "spotuify-engine"
    system "patchelf", "--set-rpath", formula_opt_lib("alsa-lib"), libexec/"spotuify-engine" if OS.linux?
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
