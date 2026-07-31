import { expect, test } from "bun:test";
import packageMetadata from "../package.json";
import { canaryVersion } from "../scripts/release-config.ts";

interface CargoManifest {
  package?: {
    version?: unknown;
    publish?: unknown;
  };
}

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

test("product and native manifests share one stable unpublished version", async () => {
  const cargo = Bun.TOML.parse(
    await Bun.file(new URL("../native/Cargo.toml", import.meta.url)).text(),
  ) as CargoManifest;
  const version = packageMetadata.version;

  expect(cargo.package?.version).toBe(version);
  expect(version).toMatch(STABLE_SEMVER);
  expect(Bun.semver.satisfies(version, version)).toBe(true);
  expect(cargo.package?.publish).toBe(false);
});

test("canary versions are immutable SemVer identifiers ordered by workflow run", () => {
  const version = canaryVersion(
    "1.2.3",
    "30600831370",
    "A1B2C3D4E5F6789012345678901234567890ABCD",
  );

  expect(version).toBe("1.2.3-canary.30600831370.ga1b2c3d4e5f6");
  expect(version).toMatch(STRICT_SEMVER);
});

test("canary versions reject ambiguous run and commit identifiers", () => {
  expect(() => canaryVersion("1.2.3", "0", "a".repeat(40))).toThrow(
    "run number must be a positive integer",
  );
  expect(() => canaryVersion("1.2.3", "42", "not-a-commit")).toThrow(
    "40 hexadecimal",
  );
});

test("canary versions require a stable canonical version", () => {
  expect(() => canaryVersion("1.2.3-beta.1", "42", "a".repeat(40))).toThrow(
    "stable semantic version",
  );
  expect(() => canaryVersion("1.2.3+build.1", "42", "a".repeat(40))).toThrow(
    "stable semantic version",
  );
});
