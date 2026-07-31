import { resolve } from "node:path";
import {
  artifactName,
  buildVersion,
  DIST_DIR,
  PRODUCT_DESCRIPTION,
  RELEASE_TARGETS,
  REPOSITORY_URL,
} from "./release-config.ts";

const version = await buildVersion();
const checksumLines = (
  await Bun.file(resolve(DIST_DIR, "SHA256SUMS")).text()
).trim().split("\n");
const checksums = new Map(
  checksumLines.map((line) => {
    const match = /^([0-9a-f]{64})  (.+(?:\.tar\.gz|\.zip))$/.exec(line);
    if (match === null) throw new Error(`invalid checksum line: ${line}`);
    return [match[2]!, match[1]!] as const;
  }),
);

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

const formula = `class Spotuify < Formula
  desc "${PRODUCT_DESCRIPTION}"
  homepage "${REPOSITORY_URL}"
  version "${version}"
${source("darwin-arm64")}
  license "MIT"

  depends_on macos: :ventura
  depends_on arch: :arm64

  def install
    bin.install "spotuify"
    libexec.install "spotuify-engine"
  end

  test do
    assert_match "spotuify #{version}", shell_output("#{bin}/spotuify --version")
    assert_match "spotuify-engine #{version}", shell_output("#{libexec}/spotuify-engine --version")
    assert_match "spotuify third-party software notices", shell_output("#{bin}/spotuify licenses")
  end
end
`;

const output = resolve(DIST_DIR, "spotuify.rb");
await Bun.write(output, formula);
console.log(`created ${output}`);
