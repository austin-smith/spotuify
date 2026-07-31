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
});
