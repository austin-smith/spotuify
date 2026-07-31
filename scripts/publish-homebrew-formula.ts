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
const formula = await Bun.file(formulaPath).text();
const result = await publishHomebrewFormula({ formula, token, version });

console.log(
  result === "unchanged"
    ? `${HOMEBREW_FORMULA_PATH} is already current`
    : `${result} ${HOMEBREW_FORMULA_PATH} in ${HOMEBREW_TAP_REPOSITORY}`,
);
