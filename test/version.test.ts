import { expect, test } from "bun:test";
import packageMetadata from "../package.json";

interface CargoManifest {
  package?: {
    version?: unknown;
    publish?: unknown;
  };
}

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

test("product and native manifests share one valid unpublished version", async () => {
  const cargo = Bun.TOML.parse(
    await Bun.file(new URL("../native/Cargo.toml", import.meta.url)).text(),
  ) as CargoManifest;
  const version = packageMetadata.version;

  expect(cargo.package?.version).toBe(version);
  expect(version).toMatch(STRICT_SEMVER);
  expect(Bun.semver.satisfies(version, version)).toBe(true);
  expect(cargo.package?.publish).toBe(false);
});
