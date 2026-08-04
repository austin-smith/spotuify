import { expect, test } from "bun:test";
import packageMetadata from "../package.json";
import { canaryVersion, normalizeCommandOutput } from "../scripts/release-config.ts";

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
  const version = canaryVersion("1.2.3", "30600831370", "2026-07-31T11:10:57Z");

  expect(version).toBe("1.2.3-canary.20260731.30600831370");
  expect(version).toMatch(STRICT_SEMVER);
});

test("canary versions reject invalid run numbers and workflow creation times", () => {
  expect(() => canaryVersion("1.2.3", "0", "2026-07-31T11:10:57Z")).toThrow(
    "run number must be a positive integer",
  );
  expect(() => canaryVersion("1.2.3", "42", "2026-07-31")).toThrow(
    "ISO 8601 UTC timestamp",
  );
  expect(() => canaryVersion("1.2.3", "42", "2026-02-29T11:10:57Z")).toThrow(
    "valid UTC timestamp",
  );
});

test("canary versions require a stable canonical version", () => {
  expect(() => canaryVersion("1.2.3-beta.1", "42", "2026-07-31T11:10:57Z")).toThrow(
    "stable semantic version",
  );
  expect(() => canaryVersion("1.2.3+build.1", "42", "2026-07-31T11:10:57Z")).toThrow(
    "stable semantic version",
  );
});

test("command output uses consistent line endings across platforms", () => {
  expect(normalizeCommandOutput("first\r\nsecond\r\n")).toBe("first\nsecond");
  expect(normalizeCommandOutput("first\nsecond\n")).toBe("first\nsecond");
});
