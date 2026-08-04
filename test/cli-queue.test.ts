import { describe, expect, test } from "bun:test";
import { queueCurrentItem } from "../src/cli/operations/queue.ts";

const webCurrent = { name: "Web Song", artist: "Web Artist" };
const runtimeItem = {
  type: "track",
  name: "Native Song",
  artist: "Native Artist",
  uri: "spotify:track:n",
};

describe("queueCurrentItem", () => {
  test("prefers the runtime's authoritative item over the lagging web read", () => {
    expect(
      queueCurrentItem({ connected: true, value: { item: runtimeItem } }, webCurrent),
    ).toMatchObject({ name: "Native Song" });
  });

  // A connected runtime saying nothing is playing outranks a stale web claim that something is.
  test("trusts a connected runtime's empty state over the web item", () => {
    expect(
      queueCurrentItem({ connected: true, value: { item: null } }, webCurrent),
    ).toBeNull();
  });

  test("falls back to the web item without a runtime", () => {
    expect(queueCurrentItem({ connected: false }, webCurrent)).toBe(webCurrent);
  });
});
