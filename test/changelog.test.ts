import { describe, expect, test } from "bun:test";
import { loadChangelog, parseChangelog, releaseNotes } from "../scripts/changelog.ts";

const VALID_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- An unreleased improvement.

## [1.1.0] - 2026-02-01

### Added

- A brand-new feature.

### Fixed

- A regression from the previous release.

## [1.0.0] - 2026-01-15

Initial release.

### Added

- Everything.

[unreleased]: https://example.com/compare/v1.1.0...HEAD
[1.1.0]: https://example.com/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
`;

describe("parseChangelog", () => {
  test("parses unreleased and release sections", () => {
    const changelog = parseChangelog(VALID_CHANGELOG);

    expect(changelog.unreleased).toBe("### Added\n\n- An unreleased improvement.");
    expect(changelog.releases.map((release) => release.version)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
    expect(changelog.releases[0]?.date).toBe("2026-02-01");
    expect(changelog.releases[0]?.notes).toBe(
      "### Added\n\n- A brand-new feature.\n\n### Fixed\n\n- A regression from the previous release.",
    );
    expect(changelog.releases[1]?.notes).toStartWith("Initial release.");
  });

  test("excludes link reference definitions from release notes", () => {
    const changelog = parseChangelog(VALID_CHANGELOG);

    for (const release of changelog.releases) {
      expect(release.notes).not.toContain("example.com");
    }
  });

  test("allows an empty unreleased section", () => {
    const changelog = parseChangelog(
      VALID_CHANGELOG.replace("### Added\n\n- An unreleased improvement.\n\n", ""),
    );

    expect(changelog.unreleased).toBe("");
    expect(changelog.releases).toHaveLength(2);
  });

  test("requires the changelog title heading", () => {
    expect(() => parseChangelog("# History\n\n## [Unreleased]\n")).toThrow(
      'must start with the "# Changelog" heading',
    );
  });

  test("requires an unreleased section", () => {
    const source = VALID_CHANGELOG.replace("## [Unreleased]\n", "");

    expect(() => parseChangelog(source)).toThrow("[Unreleased] section must precede");
  });

  test("rejects duplicate unreleased sections", () => {
    const source = VALID_CHANGELOG.replace(
      "## [1.1.0] - 2026-02-01",
      "## [Unreleased]\n\n## [1.1.0] - 2026-02-01",
    );

    expect(() => parseChangelog(source)).toThrow("exactly one [Unreleased] section");
  });

  test("rejects malformed release headings", () => {
    const source = VALID_CHANGELOG.replace("## [1.1.0] - 2026-02-01", "## 1.1.0");

    expect(() => parseChangelog(source)).toThrow(
      'must use the form "## [X.Y.Z] - YYYY-MM-DD"',
    );
  });

  test("rejects unstable release versions", () => {
    const source = VALID_CHANGELOG.replace("[1.1.0] - 2026-02-01", "[1.1.0-rc.1] - 2026-02-01");

    expect(() => parseChangelog(source)).toThrow("must use X.Y.Z format");
  });

  test("rejects invalid release dates", () => {
    const source = VALID_CHANGELOG.replace("2026-02-01", "2026-02-30");

    expect(() => parseChangelog(source)).toThrow("must use a YYYY-MM-DD date");
  });

  test("rejects releases listed out of order", () => {
    const source = VALID_CHANGELOG.replaceAll("[1.1.0]", "[0.9.0]");

    expect(() => parseChangelog(source)).toThrow("newest to oldest");
  });

  test("rejects empty release sections", () => {
    const source = VALID_CHANGELOG.replace(
      "### Added\n\n- A brand-new feature.\n\n### Fixed\n\n- A regression from the previous release.\n\n",
      "",
    );

    expect(() => parseChangelog(source)).toThrow("release 1.1.0 must not be empty");
  });

  test("rejects unknown categories", () => {
    const source = VALID_CHANGELOG.replace("### Fixed", "### Improved");

    expect(() => parseChangelog(source)).toThrow('category "Improved"');
  });

  test("requires a link reference for every section", () => {
    const withoutRelease = VALID_CHANGELOG.replace(
      "[1.1.0]: https://example.com/compare/v1.0.0...v1.1.0\n",
      "",
    );
    const withoutUnreleased = VALID_CHANGELOG.replace(
      "[unreleased]: https://example.com/compare/v1.1.0...HEAD\n",
      "",
    );

    expect(() => parseChangelog(withoutRelease)).toThrow("link reference for [1.1.0]");
    expect(() => parseChangelog(withoutUnreleased)).toThrow(
      "link reference for [Unreleased]",
    );
  });
});

describe("releaseNotes", () => {
  test("extracts the notes for a released version", () => {
    const notes = releaseNotes(parseChangelog(VALID_CHANGELOG), "1.1.0");

    expect(notes).toStartWith("### Added");
    expect(notes).toContain("A regression from the previous release.");
    expect(notes).not.toContain("unreleased improvement");
  });

  test("rejects versions without a release section", () => {
    expect(() => releaseNotes(parseChangelog(VALID_CHANGELOG), "1.2.0")).toThrow(
      "no release section for 1.2.0",
    );
  });

  test("rejects non-stable version arguments", () => {
    expect(() => releaseNotes(parseChangelog(VALID_CHANGELOG), "v1.1.0")).toThrow(
      "X.Y.Z version",
    );
  });
});

describe("repository changelog", () => {
  test("is valid and covers every published release", async () => {
    const changelog = await loadChangelog();

    expect(releaseNotes(changelog, "0.1.0")).not.toBe("");
    expect(releaseNotes(changelog, "0.1.1")).not.toBe("");
  });
});
