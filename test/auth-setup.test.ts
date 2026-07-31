import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { ensureClientId } from "../src/auth/setup.ts";
import { MissingClientIdError, REDIRECT_URI, saveClientId } from "../src/config.ts";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Spotify app setup", () => {
  test("does nothing when a Client ID is already configured", async () => {
    let prompted = false;
    let saved = false;
    const messages: string[] = [];

    const clientId = await ensureClientId({
      resolve: async () => "configured-client-id",
      question: async () => {
        prompted = true;
        return "unused";
      },
      save: async () => {
        saved = true;
      },
      log: (message) => messages.push(message),
    });

    expect(clientId).toBe("configured-client-id");
    expect(prompted).toBe(false);
    expect(saved).toBe(false);
    expect(messages).toEqual([]);
  });

  test("guides the user and saves a missing Client ID", async () => {
    const messages: string[] = [];
    const prompts: string[] = [];
    let savedClientId: string | undefined;

    const clientId = await ensureClientId({
      resolve: async () => {
        throw new MissingClientIdError();
      },
      question: async (prompt) => {
        prompts.push(prompt);
        return "  pasted-client-id  ";
      },
      save: async (value) => {
        savedClientId = value;
      },
      log: (message) => messages.push(message),
    });

    expect(clientId).toBe("pasted-client-id");
    expect(savedClientId).toBe("pasted-client-id");
    expect(prompts).toEqual(["Client ID: "]);
    expect(messages).toEqual([
      [
        "Spotify app setup",
        "",
        "1. Create an app: https://developer.spotify.com/dashboard",
        `2. Add this redirect URI: ${REDIRECT_URI}`,
        "3. Paste the app’s Client ID below.",
        "",
      ].join("\n"),
      "\nSaved for future use.\n",
    ]);
  });

  test("does not save an empty Client ID", async () => {
    let saved = false;

    await expect(
      ensureClientId({
        resolve: async () => {
          throw new MissingClientIdError();
        },
        question: async () => "   ",
        save: async () => {
          saved = true;
        },
        log: () => {},
      }),
    ).rejects.toThrow("Client ID cannot be empty.");
    expect(saved).toBe(false);
  });
});

test("saving a Client ID preserves config and uses owner-only permissions", async () => {
  directory = await mkdtemp(join(tmpdir(), "spotuify-config-test-"));
  const configDirectory = join(directory, "spotuify");
  const configPath = join(configDirectory, "config.json");
  await mkdir(configDirectory);
  await writeFile(configPath, '{"futureOption":true}\n');

  await saveClientId("  pasted-client-id  ", configPath);

  expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
    futureOption: true,
    clientId: "pasted-client-id",
  });
  expect((await stat(configPath)).mode & 0o777).toBe(0o600);
});
