import { describe, expect, test } from "bun:test";
import {
  eligibleSearchTypes,
  IncompatibleSearchFilterError,
  searchFilters,
} from "../src/api/search-query.ts";

describe("Spotify search field filters", () => {
  test("keeps type: as ordinary text because scope is explicit UI state", () => {
    expect(searchFilters("type:album motion sickness")).toEqual([]);
    expect(eligibleSearchTypes("all", "type:album motion sickness")).toEqual([
      "track",
      "artist",
      "album",
      "playlist",
    ]);
  });

  test("narrows all-scope requests to types compatible with official filters", () => {
    expect(eligibleSearchTypes("all", 'genre:"indie pop" year:2020-2026')).toEqual([
      "track",
      "artist",
    ]);
    expect(eligibleSearchTypes("all", "upc:012345678901")).toEqual(["album"]);
  });

  test("allows compatible filters in an explicit scope", () => {
    expect(eligibleSearchTypes("track", "artist:phoebe album:punisher")).toEqual(["track"]);
  });

  test("recognizes only Spotify's two documented tag filters", () => {
    expect(searchFilters("tag:new")).toEqual(["tag"]);
    expect(searchFilters("tag:hipster")).toEqual(["tag"]);
    expect(searchFilters("tag:made-up")).toEqual([]);
    expect(eligibleSearchTypes("all", "tag:made-up ambient")).toEqual([
      "track",
      "artist",
      "album",
      "playlist",
    ]);
  });

  test("explains incompatible scope and filter combinations", () => {
    expect(() => eligibleSearchTypes("playlist", "genre:ambient")).toThrow(
      new IncompatibleSearchFilterError("genre: cannot filter playlist results"),
    );
  });

  test("rejects filter combinations with no compatible Spotify type", () => {
    expect(() => eligibleSearchTypes("all", "genre:ambient upc:012345678901")).toThrow(
      "genre: + upc: cannot be combined",
    );
  });
});
