import { isStableVersion } from "../src/semver.ts";
import type { HomebrewMetadata } from "./homebrew-formula.ts";
import {
  HOMEBREW_FORMULA_PATH,
  HOMEBREW_METADATA_PATH,
  HOMEBREW_TAP_REPOSITORY,
} from "./release-config.ts";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface PublishHomebrewFormulaOptions {
  readonly apiBaseUrl?: string;
  readonly fetcher?: Fetcher;
  readonly formula: string;
  readonly metadata: string;
  readonly token: string;
  readonly version: string;
}

export type HomebrewPublishResult =
  | { readonly status: "unchanged" }
  | {
      readonly branch: string;
      readonly headSha: string;
      readonly pullRequestUrl: string;
      readonly status: "created" | "updated";
    };

interface GitHubContent {
  readonly content?: unknown;
  readonly encoding?: unknown;
}

interface GitHubReference {
  readonly object?: { readonly sha?: unknown };
}

function formulaVersion(formula: string): string | undefined {
  const explicit = /^\s*version "([^"]+)"$/m.exec(formula)?.[1];
  if (isStableVersion(explicit)) return explicit;

  const source =
    /\/releases\/download\/v(\d+\.\d+\.\d+)\/spotuify-v(\d+\.\d+\.\d+)-[^"/]+/.exec(
      formula,
    );
  return source !== null && source[1] === source[2] ? source[1] : undefined;
}

function parseMetadata(source: string): HomebrewMetadata {
  const parsed = JSON.parse(source) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Homebrew metadata must be an object");
  }
  const value = parsed as Record<string, unknown>;
  if (value["schema"] !== 1 || !isStableVersion(value["version"])) {
    throw new Error("Homebrew metadata must contain schema 1 and a stable version");
  }
  if (Object.keys(value).sort().join(",") !== "schema,version") {
    throw new Error("Homebrew metadata contains unexpected fields");
  }
  return { schema: 1, version: value["version"] };
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub returned an invalid ${description}`);
  }
  return value;
}

export async function publishHomebrewFormula({
  apiBaseUrl = "https://api.github.com",
  fetcher = fetch,
  formula,
  metadata,
  token,
  version,
}: PublishHomebrewFormulaOptions): Promise<HomebrewPublishResult> {
  if (formulaVersion(formula) !== version) {
    throw new Error(`formula source does not declare version ${version}`);
  }
  if (parseMetadata(metadata).version !== version) {
    throw new Error(`Homebrew metadata does not declare version ${version}`);
  }

  const base =
    `${apiBaseUrl.replace(/\/$/, "")}/repos/${HOMEBREW_TAP_REPOSITORY}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "spotuify-release",
    "X-GitHub-Api-Version": "2026-03-10",
  };

  async function request(
    path: string,
    init: RequestInit = {},
    expectedStatuses: readonly number[] = [200],
  ): Promise<Response> {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(
        `GitHub API ${init.method ?? "GET"} ${path} failed: ` +
          `${response.status} ${await response.text()}`,
      );
    }
    return response;
  }

  async function readText(
    path: string,
    ref: string,
  ): Promise<string | undefined> {
    const response = await request(
      `/contents/${path}?ref=${encodeURIComponent(ref)}`,
      {},
      [200, 404],
    );
    if (response.status === 404) return undefined;
    const content = (await response.json()) as GitHubContent;
    if (content.encoding !== "base64" || typeof content.content !== "string") {
      throw new Error(`GitHub returned invalid contents for ${path}`);
    }
    return Buffer.from(content.content, "base64").toString("utf8");
  }

  async function readReference(ref: string): Promise<string | undefined> {
    const response = await request(`/git/ref/heads/${ref}`, {}, [200, 404]);
    if (response.status === 404) return undefined;
    const reference = (await response.json()) as GitHubReference;
    return requiredString(reference.object?.sha, `SHA for ${ref}`);
  }

  const [currentMetadata, currentFormula] = await Promise.all([
    readText(HOMEBREW_METADATA_PATH, "main"),
    readText(HOMEBREW_FORMULA_PATH, "main"),
  ]);
  const currentVersion = currentMetadata === undefined
    ? currentFormula === undefined
      ? undefined
      : formulaVersion(currentFormula)
    : parseMetadata(currentMetadata).version;
  if (currentVersion !== undefined) {
    const order = Bun.semver.order(currentVersion, version);
    if (order > 0) {
      throw new Error(
        `refusing to replace newer Homebrew release ${currentVersion} with ${version}`,
      );
    }
    if (order === 0) return { status: "unchanged" };
  }

  const branch = `spotuify-${version.replaceAll(".", "-")}`;
  const mainSha = await readReference("main");
  if (mainSha === undefined) throw new Error("Homebrew tap has no main branch");
  let branchSha = await readReference(branch);
  if (branchSha === undefined) {
    const response = await request(
      "/git/refs",
      {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainSha }),
      },
      [201],
    );
    const reference = (await response.json()) as GitHubReference;
    branchSha = requiredString(reference.object?.sha, `SHA for ${branch}`);
  }

  const [branchFormula, branchMetadata] = await Promise.all([
    readText(HOMEBREW_FORMULA_PATH, branch),
    readText(HOMEBREW_METADATA_PATH, branch),
  ]);
  if (branchFormula !== formula || branchMetadata !== metadata) {
    const commitResponse = await request(`/git/commits/${branchSha}`);
    const commit = (await commitResponse.json()) as {
      readonly tree?: { readonly sha?: unknown };
    };
    const baseTree = requiredString(commit.tree?.sha, `tree for ${branchSha}`);
    const treeResponse = await request(
      "/git/trees",
      {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTree,
          tree: [
            {
              path: HOMEBREW_FORMULA_PATH,
              mode: "100644",
              type: "blob",
              content: formula,
            },
            {
              path: HOMEBREW_METADATA_PATH,
              mode: "100644",
              type: "blob",
              content: metadata,
            },
          ],
        }),
      },
      [201],
    );
    const tree = (await treeResponse.json()) as { readonly sha?: unknown };
    const treeSha = requiredString(tree.sha, "created tree SHA");
    const newCommitResponse = await request(
      "/git/commits",
      {
        method: "POST",
        body: JSON.stringify({
          message: `update spotuify to ${version}`,
          tree: treeSha,
          parents: [branchSha],
        }),
      },
      [201],
    );
    const newCommit = (await newCommitResponse.json()) as {
      readonly sha?: unknown;
    };
    branchSha = requiredString(newCommit.sha, "created commit SHA");
    await request(`/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: branchSha, force: false }),
    });
  }

  const owner = HOMEBREW_TAP_REPOSITORY.split("/")[0]!;
  const query = new URLSearchParams({
    state: "open",
    head: `${owner}:${branch}`,
    base: "main",
  });
  const pullsResponse = await request(`/pulls?${query}`);
  const pulls = (await pullsResponse.json()) as Array<{
    readonly html_url?: unknown;
  }>;
  let pullRequestUrl: string;
  let status: "created" | "updated";
  if (pulls.length > 0) {
    pullRequestUrl = requiredString(
      pulls[0]?.html_url,
      "Homebrew pull request URL",
    );
    status = "updated";
  } else {
    const pullResponse = await request(
      "/pulls",
      {
        method: "POST",
        body: JSON.stringify({
          title: `Update Spotuify to ${version}`,
          head: branch,
          base: "main",
          body:
            `Build and publish Homebrew bottles for Spotuify ${version}.\n\n` +
            `Merge only through the tap's brew pr-pull workflow after every ` +
            `test-bot job passes for the reviewed head SHA.`,
        }),
      },
      [201],
    );
    const pull = (await pullResponse.json()) as { readonly html_url?: unknown };
    pullRequestUrl = requiredString(
      pull.html_url,
      "created Homebrew pull request URL",
    );
    status = "created";
  }

  return {
    branch,
    headSha: branchSha,
    pullRequestUrl,
    status,
  };
}
