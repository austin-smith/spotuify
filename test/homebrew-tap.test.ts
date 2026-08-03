import { describe, expect, it } from "bun:test";
import {
  homebrewFormula,
  homebrewMetadata,
} from "../scripts/homebrew-formula.ts";
import { publishHomebrewFormula } from "../scripts/homebrew-tap.ts";

const version = "1.2.3";
const formula = homebrewFormula(
  version,
  new Map([[`spotuify-v${version}-source.tar.gz`, "a".repeat(64)]]),
);
const metadata = homebrewMetadata(version);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface GitHubFixtureOptions {
  readonly branchCurrent?: boolean;
  readonly currentVersion?: string;
  readonly openPullRequest?: boolean;
}

function githubFixture(options: GitHubFixtureOptions = {}) {
  const requests: Array<{
    readonly body?: unknown;
    readonly method: string;
    readonly path: string;
  }> = [];
  const refs = new Map<string, string>([["main", "main-sha"]]);
  if (options.branchCurrent) refs.set("spotuify-1-2-3", "branch-sha");

  const currentVersion = options.currentVersion ?? "1.2.2";
  const files = new Map<string, Map<string, string>>([
    [
      "main",
      new Map([
        [
          "Formula/spotuify.rb",
          homebrewFormula(
            currentVersion,
            new Map([
              [`spotuify-v${currentVersion}-source.tar.gz`, "b".repeat(64)],
            ]),
          ),
        ],
        ["metadata/spotuify.json", homebrewMetadata(currentVersion)],
      ]),
    ],
  ]);
  if (options.branchCurrent) {
    files.set(
      "spotuify-1-2-3",
      new Map([
        ["Formula/spotuify.rb", formula],
        ["metadata/spotuify.json", metadata],
      ]),
    );
  }

  const pulls: Array<{ html_url: string }> = options.openPullRequest
    ? [{ html_url: "https://example.test/pull/7" }]
    : [];

  const fetcher = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(
      "/repos/austin-smith/homebrew-tap",
      "",
    );
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path: `${path}${url.search}`, body });

    const contentMatch = /^\/contents\/(.+)$/.exec(path);
    if (method === "GET" && contentMatch !== null) {
      const ref = url.searchParams.get("ref") ?? "main";
      const content = files.get(ref)?.get(contentMatch[1]!);
      return content === undefined
        ? jsonResponse({}, 404)
        : jsonResponse({
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          });
    }

    const refMatch = /^\/git\/ref\/heads\/(.+)$/.exec(path);
    if (method === "GET" && refMatch !== null) {
      const sha = refs.get(refMatch[1]!);
      return sha === undefined
        ? jsonResponse({}, 404)
        : jsonResponse({ object: { sha } });
    }
    if (method === "POST" && path === "/git/refs") {
      const ref = String((body as { ref: string }).ref).replace("refs/heads/", "");
      const sha = (body as { sha: string }).sha;
      refs.set(ref, sha);
      return jsonResponse({ object: { sha } }, 201);
    }
    if (method === "GET" && path.startsWith("/git/commits/")) {
      return jsonResponse({ tree: { sha: "base-tree-sha" } });
    }
    if (method === "POST" && path === "/git/trees") {
      return jsonResponse({ sha: "new-tree-sha" }, 201);
    }
    if (method === "POST" && path === "/git/commits") {
      return jsonResponse({ sha: "new-commit-sha" }, 201);
    }
    if (method === "PATCH" && path.startsWith("/git/refs/heads/")) {
      const ref = path.replace("/git/refs/heads/", "");
      refs.set(ref, (body as { sha: string }).sha);
      return jsonResponse({ object: { sha: (body as { sha: string }).sha } });
    }
    if (method === "GET" && path === "/pulls") {
      return jsonResponse(pulls);
    }
    if (method === "POST" && path === "/pulls") {
      pulls.push({ html_url: "https://example.test/pull/8" });
      return jsonResponse(pulls.at(-1), 201);
    }
    return jsonResponse({ error: `${method} ${path}` }, 500);
  };

  return { fetcher, requests };
}

describe("Homebrew formula", () => {
  it("builds from immutable source with declared platform dependencies", () => {
    expect(formula).toContain(
      `url "https://github.com/austin-smith/spotuify/releases/download/v${version}/spotuify-v${version}-source.tar.gz"`,
    );
    expect(formula).toContain('depends_on "bun" => :build');
    expect(formula).toContain('depends_on "rust" => :build');
    expect(formula).toContain("on_macos do");
    expect(formula).toContain("depends_on arch: :arm64");
    expect(formula).toContain("on_linux do");
    expect(formula).toContain('depends_on "pkgconf" => :build');
    expect(formula).toContain('depends_on "alsa-lib"');
    expect(formula).toContain('system "bun", "install", "--frozen-lockfile", "--ignore-scripts"');
    expect(formula).toContain('system "bun", "run", "scripts/build-homebrew.ts"');
    expect(formula).toContain(
      '(bin/"spotuify").write_env_script libexec/"spotuify", SPOTUIFY_INSTALL_SOURCE: "homebrew"',
    );
    expect(formula).not.toMatch(/^\s*version /m);
    expect(formula).not.toContain("darwin-arm64.tar.gz");
    expect(formula).not.toContain("linux-x64.tar.gz");
  });

  it("renders strict machine-readable update metadata", () => {
    expect(JSON.parse(metadata)).toEqual({ schema: 1, version });
  });
});

describe("Homebrew tap publisher", () => {
  it("creates one atomic formula-and-metadata commit and opens a pull request", async () => {
    const fixture = githubFixture();
    const result = await publishHomebrewFormula({
      apiBaseUrl: "https://api.example.test",
      fetcher: fixture.fetcher,
      formula,
      metadata,
      token: "secret",
      version,
    });

    expect(result).toEqual({
      branch: "spotuify-1-2-3",
      headSha: "new-commit-sha",
      pullRequestUrl: "https://example.test/pull/8",
      status: "created",
    });
    const tree = fixture.requests.find(
      (request) => request.method === "POST" && request.path === "/git/trees",
    )?.body as {
      tree: Array<{
        path: string;
        mode: string;
        type: string;
        content: string;
      }>;
    };
    expect(tree.tree).toEqual([
      { path: "Formula/spotuify.rb", mode: "100644", type: "blob", content: formula },
      { path: "metadata/spotuify.json", mode: "100644", type: "blob", content: metadata },
    ]);
    expect(
      fixture.requests.find(
        (request) => request.method === "PATCH" && request.path.includes("/git/refs/"),
      )?.body,
    ).toEqual({ sha: "new-commit-sha", force: false });
    const pull = fixture.requests.find(
      (request) => request.method === "POST" && request.path === "/pulls",
    )?.body as { title: string; head: string; base: string; body: string };
    expect(pull).toMatchObject({
      title: "Update Spotuify to 1.2.3",
      head: "spotuify-1-2-3",
      base: "main",
    });
    expect(pull.body).toContain("reviewed head SHA");
  });

  it("reuses a current version branch and its open pull request", async () => {
    const fixture = githubFixture({ branchCurrent: true, openPullRequest: true });
    const result = await publishHomebrewFormula({
      fetcher: fixture.fetcher,
      formula,
      metadata,
      token: "secret",
      version,
    });

    expect(result).toEqual({
      branch: "spotuify-1-2-3",
      headSha: "branch-sha",
      pullRequestUrl: "https://example.test/pull/7",
      status: "updated",
    });
    expect(
      fixture.requests.some((request) => request.method === "POST" && request.path === "/git/trees"),
    ).toBe(false);
  });

  it("does nothing after the requested version is published with bottles", async () => {
    const fixture = githubFixture({ currentVersion: version });
    await expect(
      publishHomebrewFormula({
        fetcher: fixture.fetcher,
        formula,
        metadata,
        token: "secret",
        version,
      }),
    ).resolves.toEqual({ status: "unchanged" });
    expect(fixture.requests.some((request) => request.path.includes("spotuify-1-2-3"))).toBe(false);
  });

  it("refuses to downgrade the tap", async () => {
    const fixture = githubFixture({ currentVersion: "1.3.0" });
    await expect(
      publishHomebrewFormula({
        fetcher: fixture.fetcher,
        formula,
        metadata,
        token: "secret",
        version,
      }),
    ).rejects.toThrow("refusing to replace newer Homebrew release 1.3.0 with 1.2.3");
  });

  it("rejects mismatched candidate metadata before calling GitHub", async () => {
    let called = false;
    await expect(
      publishHomebrewFormula({
        fetcher: async () => {
          called = true;
          return jsonResponse({});
        },
        formula,
        metadata: homebrewMetadata("1.2.4"),
        token: "secret",
        version,
      }),
    ).rejects.toThrow("Homebrew metadata does not declare version 1.2.3");
    expect(called).toBe(false);
  });
});
