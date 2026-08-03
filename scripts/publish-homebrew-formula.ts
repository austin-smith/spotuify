import { resolve } from "node:path";
import { publishHomebrewFormula } from "./homebrew-tap.ts";
import {
  DIST_DIR,
  HOMEBREW_FORMULA_PATH,
  HOMEBREW_TAP_REPOSITORY,
  productVersion,
} from "./release-config.ts";

const token = Bun.env.GH_TOKEN;
if (token === undefined || token.length === 0) {
  throw new Error("GH_TOKEN is required to publish the Homebrew formula");
}

const version = await productVersion();
const formulaPath = resolve(process.argv[2] ?? resolve(DIST_DIR, "spotuify.rb"));
const metadataPath = resolve(
  process.argv[3] ?? resolve(DIST_DIR, "spotuify.json"),
);
const [formula, metadata] = await Promise.all([
  Bun.file(formulaPath).text(),
  Bun.file(metadataPath).text(),
]);
const result = await publishHomebrewFormula({
  formula,
  metadata,
  token,
  version,
});

if (result.status === "unchanged") {
  console.log(`${HOMEBREW_FORMULA_PATH} is already current`);
} else {
  console.log(
    `${result.status} ${result.pullRequestUrl} at ${result.headSha}; ` +
      `publish through brew pr-pull after test-bot passes`,
  );
}
