import packageMetadata from "../package.json";

declare const SPOTUIFY_BUILD_VERSION: string | undefined;

/** Canonical product version, overridden only in compiled development-channel builds. */
export const VERSION =
  typeof SPOTUIFY_BUILD_VERSION === "string"
    ? SPOTUIFY_BUILD_VERSION
    : packageMetadata.version;
