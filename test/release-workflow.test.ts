import { describe, expect, test } from "bun:test";

const WORKFLOW_PATH = new URL("../.github/workflows/release.yml", import.meta.url);

describe("release workflow", () => {
  test("publishes stable releases from canonical version tags", async () => {
    const source = await Bun.file(WORKFLOW_PATH).text();
    const workflow = Bun.YAML.parse(source) as {
      on?: {
        push?: { branches?: string[]; tags?: string[] };
      };
    };

    expect(workflow.on?.push).toEqual({
      branches: ["main"],
      tags: ["v[0-9]+.[0-9]+.[0-9]+"],
    });
    expect(source).toContain('bun run release:validate-tag "$GITHUB_REF_NAME"');
    expect(source).toContain('git merge-base --is-ancestor "$tag_commit" origin/main');
    expect(source).toContain("--verify-tag");
  });

  test("publishes curated release notes from the changelog", async () => {
    const source = await Bun.file(WORKFLOW_PATH).text();

    expect(source).toContain('bun run release:changelog check "${GITHUB_REF_NAME#v}"');
    expect(source).toContain(
      'bun run release:changelog extract "$SPOTUIFY_BUILD_VERSION" > dist/release-notes.md',
    );
    expect(source).toContain("--notes-file dist/release-notes.md");
    expect(source).not.toContain("--generate-notes");
  });

  test("does not require workstation-specific tag signing", async () => {
    const source = await Bun.file(WORKFLOW_PATH).text();

    expect(source).not.toContain("Verify release tag signature");
    expect(source).not.toContain("GitHub-verified signature");
  });

  test("publishes standalone installers and verifies the crapshack endpoints", async () => {
    const source = await Bun.file(WORKFLOW_PATH).text();

    expect(source).toContain(
      "install -m 0755 packaging/standalone/install.sh dist/install.sh",
    );
    expect(source).toContain(
      "install -m 0644 packaging/standalone/install.ps1 dist/install.ps1",
    );
    expect(source).toContain(
      "dist/*.tar.gz dist/*.zip dist/*-standalone-* dist/install.sh dist/install.ps1",
    );
    expect(source).toContain("https://crapshack.net/spotuify/install.sh");
    expect(source).toContain("https://crapshack.net/spotuify/install.ps1");
  });
});
