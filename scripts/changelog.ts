import { resolve } from "node:path";
import { compareSemanticVersions, isStableVersion } from "../src/semver.ts";
import { REPO_ROOT } from "./release-config.ts";

export interface ChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly notes: string;
}

export interface Changelog {
  readonly unreleased: string;
  readonly releases: readonly ChangelogRelease[];
}

const TITLE_HEADING = "# Changelog";
const UNRELEASED_HEADING = "## [Unreleased]";
const RELEASE_HEADING = /^## \[([^\]]*)\] - (.*)$/;
const LINK_DEFINITION = /^\[([^\]]+)\]:\s+\S+$/;
const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

interface ReleaseDraft {
  readonly version: string;
  readonly date: string;
  readonly lines: string[];
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isInteger(time) && new Date(time).toISOString().startsWith(value);
}

export function parseChangelog(source: string): Changelog {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== TITLE_HEADING) {
    throw new Error(`CHANGELOG.md must start with the "${TITLE_HEADING}" heading`);
  }

  const linkLabels = new Set<string>();
  for (const line of lines) {
    const definition = line.match(LINK_DEFINITION);
    if (definition !== null) linkLabels.add(definition[1]!.toLowerCase());
  }

  const drafts: ReleaseDraft[] = [];
  let unreleased: string[] | null = null;
  let section: string[] | null = null;

  for (const line of lines.slice(1)) {
    if (LINK_DEFINITION.test(line)) continue;
    if (line.startsWith("## ")) {
      if (line === UNRELEASED_HEADING) {
        if (unreleased !== null) {
          throw new Error("CHANGELOG.md must contain exactly one [Unreleased] section");
        }
        unreleased = section = [];
        continue;
      }
      if (unreleased === null) {
        throw new Error("the [Unreleased] section must precede every release section");
      }
      const heading = line.match(RELEASE_HEADING);
      if (heading === null) {
        throw new Error(`changelog heading "${line}" must use the form "## [X.Y.Z] - YYYY-MM-DD"`);
      }
      const [, version, date] = heading;
      if (!isStableVersion(version)) {
        throw new Error(`changelog release version must use X.Y.Z format, received ${version}`);
      }
      if (!isCalendarDate(date!)) {
        throw new Error(`changelog release ${version} must use a YYYY-MM-DD date, received ${date}`);
      }
      const draft = { version, date: date!, lines: [] };
      drafts.push(draft);
      section = draft.lines;
      continue;
    }
    if (section !== null && line.startsWith("### ")) {
      const category = line.slice("### ".length).trim();
      if (!CATEGORIES.includes(category)) {
        throw new Error(
          `changelog category "${category}" must be one of ${CATEGORIES.join(", ")}`,
        );
      }
    }
    section?.push(line);
  }

  if (unreleased === null) {
    throw new Error("CHANGELOG.md must contain an [Unreleased] section");
  }
  if (!linkLabels.has("unreleased")) {
    throw new Error("CHANGELOG.md must define a link reference for [Unreleased]");
  }

  const releases = drafts.map((draft): ChangelogRelease => {
    const notes = draft.lines.join("\n").trim();
    if (notes === "") {
      throw new Error(`changelog release ${draft.version} must not be empty`);
    }
    if (!linkLabels.has(draft.version)) {
      throw new Error(`CHANGELOG.md must define a link reference for [${draft.version}]`);
    }
    return { version: draft.version, date: draft.date, notes };
  });
  for (let index = 1; index < releases.length; index += 1) {
    const newer = releases[index - 1]!.version;
    const older = releases[index]!.version;
    if (compareSemanticVersions(newer, older) !== 1) {
      throw new Error(
        `changelog releases must be listed from newest to oldest without duplicates; ` +
          `${newer} appears before ${older}`,
      );
    }
  }
  return { unreleased: unreleased.join("\n").trim(), releases };
}

export function releaseNotes(changelog: Changelog, version: string): string {
  if (!isStableVersion(version)) {
    throw new Error(`release notes require an X.Y.Z version, received ${version}`);
  }
  const release = changelog.releases.find((entry) => entry.version === version);
  if (release === undefined) {
    throw new Error(
      `CHANGELOG.md has no release section for ${version}; ` +
        "move its entries from [Unreleased] to a dated section before releasing",
    );
  }
  return release.notes;
}

export async function loadChangelog(repoRoot = REPO_ROOT): Promise<Changelog> {
  const file = Bun.file(resolve(repoRoot, "CHANGELOG.md"));
  if (!(await file.exists())) {
    throw new Error("CHANGELOG.md is missing");
  }
  return parseChangelog(await file.text());
}

if (import.meta.main) {
  const [action, version] = process.argv.slice(2);
  if ((action !== "check" && action !== "extract") || version === undefined) {
    throw new Error("usage: changelog.ts <check|extract> <version>");
  }
  const notes = releaseNotes(await loadChangelog(), version);
  if (action === "extract") {
    console.log(notes);
  } else {
    console.log(`CHANGELOG.md has release notes for ${version}`);
  }
}
