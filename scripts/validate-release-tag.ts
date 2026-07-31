import { productVersion } from "./release-config.ts";

const tag = process.argv[2];
const version = await productVersion();
if (tag !== `v${version}`) {
  throw new Error(`release tag must be v${version}, received ${tag ?? "no tag"}`);
}
console.log(`${tag} matches package.json and native/Cargo.toml`);
