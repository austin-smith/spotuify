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

  test("publishes source while keeping the unbottled formula out of the release", async () => {
    const source = await Bun.file(WORKFLOW_PATH).text();

    expect(source).toContain("bun run release:package-source");
    expect(source.indexOf("bun run release:package-source")).toBeLessThan(
      source.indexOf("bun run release:checksums"),
    );
    expect(source).toContain("name: homebrew-candidate");
    expect(source).toContain("dist/spotuify.rb");
    expect(source).toContain("dist/spotuify.json");
    expect(source).not.toContain("dist/SHA256SUMS dist/spotuify.rb");
  });

  test("opens a tap pull request instead of committing an untested formula to main", async () => {
    const source = await Bun.file(WORKFLOW_PATH).text();

    expect(source).toContain("name: Open Homebrew formula pull request");
    expect(source).toContain("dist/homebrew/spotuify.rb");
    expect(source).toContain("dist/homebrew/spotuify.json");
    expect(source).not.toContain("--pattern spotuify.rb");
  });
});
