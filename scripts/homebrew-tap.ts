import {
  HOMEBREW_FORMULA_PATH,
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
  readonly token: string;
  readonly version: string;
}

export type HomebrewPublishResult = "created" | "updated" | "unchanged";

function formulaVersion(formula: string): string | undefined {
  return /^\s*version "([^"]+)"$/m.exec(formula)?.[1];
}

export async function publishHomebrewFormula({
  apiBaseUrl = "https://api.github.com",
  fetcher = fetch,
  formula,
  token,
  version,
}: PublishHomebrewFormulaOptions): Promise<HomebrewPublishResult> {
  const declaredVersion = formulaVersion(formula);
  if (declaredVersion !== version) {
    throw new Error(
      `formula declares version ${declaredVersion ?? "(missing)"}, expected ${version}`,
    );
  }

  const apiUrl =
    `${apiBaseUrl.replace(/\/$/, "")}/repos/${HOMEBREW_TAP_REPOSITORY}/contents/` +
    HOMEBREW_FORMULA_PATH;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "spotuify-release",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const currentResponse = await fetcher(`${apiUrl}?ref=main`, { headers });
  let currentSha: string | undefined;

  if (currentResponse.ok) {
    const current = (await currentResponse.json()) as {
      content?: unknown;
      encoding?: unknown;
      sha?: unknown;
    };
    if (
      typeof current.content !== "string" ||
      current.encoding !== "base64" ||
      typeof current.sha !== "string"
    ) {
      throw new Error("GitHub returned an invalid current formula response");
    }

    const currentFormula = Buffer.from(current.content, "base64").toString("utf8");
    if (currentFormula === formula) return "unchanged";

    const currentVersion = formulaVersion(currentFormula);
    if (currentVersion === undefined) {
      throw new Error(`current ${HOMEBREW_FORMULA_PATH} has no version`);
    }
    if (Bun.semver.order(currentVersion, version) > 0) {
      throw new Error(
        `refusing to replace newer Homebrew formula ${currentVersion} with ${version}`,
      );
    }
    currentSha = current.sha;
  } else if (currentResponse.status !== 404) {
    throw new Error(
      `failed to read current formula: ${currentResponse.status} ${await currentResponse.text()}`,
    );
  }

  const updateResponse = await fetcher(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `update spotuify to v${version}`,
      content: Buffer.from(formula).toString("base64"),
      branch: "main",
      ...(currentSha === undefined ? {} : { sha: currentSha }),
    }),
  });

  if (!updateResponse.ok) {
    throw new Error(
      `failed to publish formula: ${updateResponse.status} ${await updateResponse.text()}`,
    );
  }
  return currentSha === undefined ? "created" : "updated";
}
