import { describe, expect, test } from "bun:test";
import {
  chooseArtwork,
  fetchArtworkImage,
} from "../src/mcp/artwork.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("MCP artwork", () => {
  test("reports when Spotify supplies no cover", async () => {
    await expect(fetchArtworkImage([])).rejects.toThrow("has no artwork");
  });

  test("selects the smallest cover at least 300 pixels wide", () => {
    const images = [
      { url: "large", width: 640, height: 640 },
      { url: "small", width: 64, height: 64 },
      { url: "medium", width: 300, height: 300 },
    ];
    expect(chooseArtwork(images)?.url).toBe("medium");
  });

  test("falls back to the largest known cover", () => {
    const images = [
      { url: "small", width: 64, height: 64 },
      { url: "larger", width: 128, height: 128 },
    ];
    expect(chooseArtwork(images)?.url).toBe("larger");
  });

  test("returns original Spotify bytes as an MCP image", async () => {
    let requested = "";
    const result = await fetchArtworkImage(
      [{ url: "https://i.scdn.co/image/cover", width: 300, height: 300 }],
      (async (input) => {
        requested = String(input);
        return new Response(jpeg, {
          headers: {
            "content-length": String(jpeg.byteLength),
            "content-type": "image/jpeg",
          },
        });
      }),
    );

    expect(requested).toBe("https://i.scdn.co/image/cover");
    expect(result).toEqual({
      source: {
        url: "https://i.scdn.co/image/cover",
        width: 300,
        height: 300,
      },
      content: {
        type: "image",
        data: Buffer.from(jpeg).toString("base64"),
        mimeType: "image/jpeg",
      },
    });
  });

  test("rejects artwork outside Spotify's image hosts before fetching", async () => {
    let fetched = false;
    await expect(
      fetchArtworkImage(
        [{ url: "https://example.com/cover.jpg", width: 300, height: 300 }],
        (async () => {
          fetched = true;
          return new Response(jpeg);
        }),
      ),
    ).rejects.toThrow("unsupported artwork location");
    expect(fetched).toBe(false);
  });

  test("validates every redirect before issuing the next request", async () => {
    const requested: string[] = [];
    await expect(
      fetchArtworkImage(
        [{ url: "https://i.scdn.co/image/cover", width: 300, height: 300 }],
        async (input) => {
          requested.push(String(input));
          return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
          });
        },
      ),
    ).rejects.toThrow("unsupported artwork location");
    expect(requested).toEqual(["https://i.scdn.co/image/cover"]);
  });

  test("follows a bounded redirect between Spotify image hosts", async () => {
    const requested: string[] = [];
    const result = await fetchArtworkImage(
      [{ url: "https://i.scdn.co/image/cover", width: 300, height: 300 }],
      async (input, init) => {
        requested.push(String(input));
        expect(init?.redirect).toBe("manual");
        if (requested.length === 1) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://image-cdn-fa.spotifycdn.com/image/cover",
            },
          });
        }
        return new Response(jpeg, {
          headers: { "content-type": "image/jpeg" },
        });
      },
    );

    expect(result.content.data).toBe(Buffer.from(jpeg).toString("base64"));
    expect(requested).toEqual([
      "https://i.scdn.co/image/cover",
      "https://image-cdn-fa.spotifycdn.com/image/cover",
    ]);
  });

  test("rejects a declared response over the size limit without reading it", async () => {
    await expect(
      fetchArtworkImage(
        [{ url: "https://i.scdn.co/image/cover", width: 300, height: 300 }],
        (async () =>
          new Response(jpeg, {
            headers: {
              "content-length": String(2 * 1024 * 1024 + 1),
              "content-type": "image/jpeg",
            },
          })),
      ),
    ).rejects.toThrow("too large");
  });

  test("rejects an undeclared response that crosses the size limit", async () => {
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    oversized.set(jpeg);
    await expect(
      fetchArtworkImage(
        [{ url: "https://i.scdn.co/image/cover", width: 300, height: 300 }],
        (async () =>
          new Response(oversized, {
            headers: { "content-type": "image/jpeg" },
          })),
      ),
    ).rejects.toThrow("too large");
  });

  test("requires the declared type to match the image signature", async () => {
    await expect(
      fetchArtworkImage(
        [{ url: "https://i.scdn.co/image/cover", width: 300, height: 300 }],
        (async () =>
          new Response(jpeg, {
            headers: { "content-type": "image/png" },
          })),
      ),
    ).rejects.toThrow("invalid content type");
  });
});
