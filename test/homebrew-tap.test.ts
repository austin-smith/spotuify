import { describe, expect, it } from "bun:test";
import { publishHomebrewFormula } from "../scripts/homebrew-tap.ts";

const formula = `class Spotuify < Formula
  version "1.2.3"
end
`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Homebrew tap publisher", () => {
  it("creates the formula when it does not exist", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ input: String(input), init });
      return requests.length === 1 ? jsonResponse({}, 404) : jsonResponse({}, 201);
    });

    const result = await publishHomebrewFormula({
      apiBaseUrl: "https://example.test/",
      fetcher,
      formula,
      token: "secret",
      version: "1.2.3",
    });

    expect(result).toBe("created");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toEndWith(
      "/repos/austin-smith/homebrew-tap/contents/Formula/spotuify.rb?ref=main",
    );
    expect(requests[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      message: "update spotuify to v1.2.3",
      content: Buffer.from(formula).toString("base64"),
      branch: "main",
    });
  });

  it("does nothing when the published formula is already current", async () => {
    const fetcher = async () =>
      jsonResponse({
        content: Buffer.from(formula).toString("base64"),
        encoding: "base64",
        sha: "existing-sha",
      });

    await expect(
      publishHomebrewFormula({
        fetcher,
        formula,
        token: "secret",
        version: "1.2.3",
      }),
    ).resolves.toBe("unchanged");
  });

  it("updates the existing formula with its current blob SHA", async () => {
    const requests: RequestInit[] = [];
    const oldFormula = formula.replace("1.2.3", "1.2.2");
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return requests.length === 1
        ? jsonResponse({
            content: Buffer.from(oldFormula).toString("base64"),
            encoding: "base64",
            sha: "existing-sha",
          })
        : jsonResponse({});
    });

    const result = await publishHomebrewFormula({
      fetcher,
      formula,
      token: "secret",
      version: "1.2.3",
    });

    expect(result).toBe("updated");
    expect(JSON.parse(String(requests[1]?.body)).sha).toBe("existing-sha");
  });

  it("refuses to downgrade a newer formula", async () => {
    const newerFormula = formula.replace("1.2.3", "1.3.0");
    const fetcher = async () =>
      jsonResponse({
        content: Buffer.from(newerFormula).toString("base64"),
        encoding: "base64",
        sha: "existing-sha",
      });

    await expect(
      publishHomebrewFormula({
        fetcher,
        formula,
        token: "secret",
        version: "1.2.3",
      }),
    ).rejects.toThrow("refusing to replace newer Homebrew formula 1.3.0 with 1.2.3");
  });
});
