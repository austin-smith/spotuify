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
  const commitTimestamp = String(Date.UTC(2026, 6, 31) / 1_000);
  const version = canaryVersion("1.2.3", "30600831370", commitTimestamp);

  expect(version).toBe("1.2.3-canary.20260731.30600831370");
  expect(version).toMatch(STRICT_SEMVER);
});

test("canary versions reject invalid run numbers and commit timestamps", () => {
  expect(() => canaryVersion("1.2.3", "0", "1785456000")).toThrow(
    "run number must be a positive integer",
  );
  expect(() => canaryVersion("1.2.3", "42", "not-a-timestamp")).toThrow(
    "timestamp must be a non-negative integer",
  );
});

test("canary versions require a stable canonical version", () => {
  expect(() => canaryVersion("1.2.3-beta.1", "42", "1785456000")).toThrow(
    "stable semantic version",
  );
  expect(() => canaryVersion("1.2.3+build.1", "42", "1785456000")).toThrow(
    "stable semantic version",
  );
});

test("command output uses consistent line endings across platforms", () => {
  expect(normalizeCommandOutput("first\r\nsecond\r\n")).toBe("first\nsecond");
  expect(normalizeCommandOutput("first\nsecond\n")).toBe("first\nsecond");
});
