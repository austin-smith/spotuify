import {
  HOMEBREW_DESCRIPTION,
  REPOSITORY_URL,
  sourceArchiveName,
} from "./release-config.ts";

export interface HomebrewMetadata {
  readonly schema: 1;
  readonly version: string;
}

export function homebrewMetadata(version: string): string {
  return `${JSON.stringify({ schema: 1, version } satisfies HomebrewMetadata, null, 2)}\n`;
}

export function homebrewFormula(
  version: string,
  checksums: ReadonlyMap<string, string>,
): string {
  const source = sourceArchiveName(version);
  const checksum = checksums.get(source);
  if (checksum === undefined) throw new Error(`missing checksum for ${source}`);

  return `class Spotuify < Formula
  desc "${HOMEBREW_DESCRIPTION}"
  homepage "${REPOSITORY_URL}"
  url "${REPOSITORY_URL}/releases/download/v${version}/${source}"
  sha256 "${checksum}"
  license "MIT"

  depends_on "bun" => :build
  depends_on "rust" => :build

  on_macos do
    depends_on arch: :arm64
    depends_on macos: :ventura
  end

  on_linux do
    depends_on "pkgconf" => :build
    depends_on "alsa-lib"
  end

  def install
    system "bun", "install", "--frozen-lockfile", "--ignore-scripts"
    system "bun", "run", "scripts/build-homebrew.ts"
    libexec.install "dist/homebrew-stage/spotuify", "dist/homebrew-stage/spotuify-engine"
    (bin/"spotuify").write_env_script libexec/"spotuify", SPOTUIFY_INSTALL_SOURCE: "homebrew"
  end

  test do
    assert_equal "spotuify #{version}\n", shell_output("#{bin}/spotuify --version")
    assert_equal "spotuify-engine #{version}\n", shell_output("#{libexec}/spotuify-engine --version")
    assert_match "Usage:", shell_output("#{bin}/spotuify --help")
    assert_match "spotuify third-party software notices", shell_output("#{bin}/spotuify licenses")
  end
end
`;
}
