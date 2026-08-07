import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import type { Image } from "../api/types.ts";
import { unavailable } from "../cli/errors.ts";

const PREFERRED_ARTWORK_EDGE = 300;
const MAX_ARTWORK_BYTES = 2 * 1024 * 1024;
const ARTWORK_TIMEOUT_MS = 10_000;
const MAX_ARTWORK_REDIRECTS = 3;

const SPOTIFY_IMAGE_HOSTS = ["scdn.co", "spotifycdn.com"] as const;

function isSpotifyImageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return SPOTIFY_IMAGE_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

/** Prefer Spotify's medium cover: detailed enough for chat without sending the largest payload. */
export function chooseArtwork(images: readonly Image[]): Image | null {
  if (images.length === 0) return null;
  const sized = images
    .filter((image) => image.width !== null && image.width > 0)
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (
    sized.find((image) => (image.width ?? 0) >= PREFERRED_ARTWORK_EDGE) ??
    sized.at(-1) ??
    images[0] ??
    null
  );
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_ARTWORK_BYTES) {
    throw unavailable("Spotify artwork is too large to return safely.");
  }
  if (response.body === null) throw unavailable("Spotify returned empty artwork.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_ARTWORK_BYTES) {
        await reader.cancel();
        throw unavailable("Spotify artwork is too large to return safely.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (length === 0) throw unavailable("Spotify returned empty artwork.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function detectedImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export interface ArtworkImage {
  content: ImageContent;
  source: Image;
}

export type ArtworkFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchFromSpotifyCdn(
  sourceUrl: string,
  fetcher: ArtworkFetcher,
): Promise<Response> {
  let currentUrl = sourceUrl;
  const signal = AbortSignal.timeout(ARTWORK_TIMEOUT_MS);

  for (let redirects = 0; ; redirects++) {
    if (!isSpotifyImageUrl(currentUrl)) {
      throw unavailable("Spotify returned an unsupported artwork location.");
    }

    let response: Response;
    try {
      response = await fetcher(currentUrl, { redirect: "manual", signal });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw unavailable("Spotify artwork request timed out.");
      }
      throw unavailable("Spotify artwork could not be loaded.");
    }

    if (!isRedirect(response.status)) return response;
    if (redirects >= MAX_ARTWORK_REDIRECTS) {
      throw unavailable("Spotify artwork redirected too many times.");
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw unavailable("Spotify artwork returned an invalid redirect.");
    }
    try {
      currentUrl = new URL(location, currentUrl).href;
    } catch {
      throw unavailable("Spotify artwork returned an invalid redirect.");
    }
  }
}

/** Fetch original Spotify-hosted artwork and package it as an MCP image content block. */
export async function fetchArtworkImage(
  images: readonly Image[],
  fetcher: ArtworkFetcher = fetch,
): Promise<ArtworkImage> {
  const source = chooseArtwork(images);
  if (source === null) throw unavailable("This Spotify resource has no artwork.");
  const response = await fetchFromSpotifyCdn(source.url, fetcher);
  if (!response.ok) {
    throw unavailable(`Spotify artwork is unavailable (HTTP ${response.status}).`);
  }

  const bytes = await boundedBytes(response);
  const detected = detectedImageType(bytes);
  if (detected === null) {
    throw unavailable("Spotify returned an unsupported artwork format.");
  }

  const declared = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const normalizedDeclared = declared === "image/jpg" ? "image/jpeg" : declared;
  if (normalizedDeclared !== undefined && normalizedDeclared !== detected) {
    throw unavailable("Spotify returned artwork with an invalid content type.");
  }

  return {
    source,
    content: {
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: detected,
    },
  };
}
