import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { prepareClientId, type ClientIdSetupEvent } from "../src/auth/setup.ts";
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

    const setup = await prepareClientId(
      {},
      {
        resolve: async () => ({ clientId: "configured-client-id", source: "config" }),
        hasAuthorization: async () => true,
        question: async () => {
          prompted = true;
          return "unused";
        },
        save: async () => {
          saved = true;
        },
        onEvent: (event) => messages.push(event.type),
      },
    );
    await setup.commit();

    expect(setup.clientId).toBe("configured-client-id");
    expect(setup.requiresAuthorization).toBe(false);
    expect(prompted).toBe(false);
    expect(saved).toBe(false);
    expect(messages).toEqual([]);
  });

  test("prompts again when saved setup never completed authorization", async () => {
    let savedClientId: string | undefined;

    const setup = await prepareClientId(
      {},
      {
        resolve: async () => ({ clientId: "unverified-client-id", source: "config" }),
        hasAuthorization: async (clientId) => {
          expect(clientId).toBe("unverified-client-id");
          return false;
        },
        question: async () => "corrected-client-id",
        save: async (clientId) => {
          savedClientId = clientId;
        },
        onEvent: () => {},
      },
    );

    expect(setup.clientId).toBe("corrected-client-id");
    expect(setup.requiresAuthorization).toBe(true);
    expect(savedClientId).toBeUndefined();

    await setup.commit();
    expect(savedClientId).toBe("corrected-client-id");
  });

  test("does not replace an explicit environment Client ID", async () => {
    let checkedAuthorization = false;
    let prompted = false;

    const setup = await prepareClientId(
      {},
      {
        resolve: async () => ({ clientId: "environment-client-id", source: "environment" }),
        hasAuthorization: async () => {
          checkedAuthorization = true;
          return false;
        },
        question: async () => {
          prompted = true;
          return "unused";
        },
        onEvent: () => {},
      },
    );

    expect(setup.clientId).toBe("environment-client-id");
    expect(setup.requiresAuthorization).toBe(false);
    expect(checkedAuthorization).toBe(false);
    expect(prompted).toBe(false);
  });

  test("reset refuses to override an environment Client ID", async () => {
    let prompted = false;
    let saved = false;

    await expect(
      prepareClientId(
        { reset: true },
        {
          resolve: async () => ({ clientId: "environment-client-id", source: "environment" }),
          question: async () => {
            prompted = true;
            return "replacement-client-id";
          },
          save: async () => {
            saved = true;
          },
          onEvent: () => {},
        },
      ),
    ).rejects.toThrow(
      "Cannot reset Client ID while the SPOTUIFY_CLIENT_ID environment variable is set. " +
        "Update it and run `spotuify auth`, or unset it and run `spotuify auth --reset`.",
    );

    expect(prompted).toBe(false);
    expect(saved).toBe(false);
  });

  test("keeps a missing Client ID pending until authorization succeeds", async () => {
    const events: ClientIdSetupEvent[] = [];
    const prompts: string[] = [];
    let savedClientId: string | undefined;

    const setup = await prepareClientId(
      {},
      {
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
        onEvent: (event) => events.push(event),
      },
    );

    expect(setup.clientId).toBe("pasted-client-id");
    expect(setup.requiresAuthorization).toBe(true);
    expect(savedClientId).toBeUndefined();
    expect(prompts).toEqual(["Client ID: "]);
    expect(events).toEqual([
      {
        type: "setup-required",
        dashboardUrl: "https://developer.spotify.com/dashboard",
        redirectUri: REDIRECT_URI,
      },
    ]);

    await setup.commit();
    await setup.commit();

    expect(savedClientId).toBe("pasted-client-id");
    expect(events.at(-1)).toEqual({ type: "saved" });
  });

  test("reset collects a replacement without changing working configuration", async () => {
    let savedClientId: string | undefined;

    const setup = await prepareClientId(
      { reset: true },
      {
        resolve: async () => ({ clientId: "working-client-id", source: "config" }),
        question: async () => "replacement-client-id",
        save: async (value) => {
          savedClientId = value;
        },
        onEvent: () => {},
      },
    );

    expect(setup.clientId).toBe("replacement-client-id");
    expect(setup.requiresAuthorization).toBe(true);
    expect(savedClientId).toBeUndefined();

    await setup.commit();
    expect(savedClientId).toBe("replacement-client-id");
  });

  test("does not save an empty Client ID", async () => {
    let saved = false;

    await expect(
      prepareClientId(
        {},
        {
          resolve: async () => {
            throw new MissingClientIdError();
          },
          question: async () => "   ",
          save: async () => {
            saved = true;
          },
          onEvent: () => {},
        },
      ),
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
