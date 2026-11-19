import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { silentLogger, systemClock } from "@ostra/adapter-sdk";
import type { AdapterContext } from "@ostra/adapter-sdk";
import { generateSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { SECRETS_KEY_MISMATCH, SECRETS_KEY_MISMATCH_MESSAGE } from "@ostra/domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { openSecretStore, SECRETS_KEY_FILE } from "./secrets.ts";

// Q136, item 1 (milestone 2's ticket 45): core checks its secrets key against the database at
// start. These run the real check against a real database, and the race and the refusal as real
// processes.

const here = path.dirname(fileURLToPath(import.meta.url));
const context: AdapterContext = { logger: silentLogger, clock: systemClock };

let test: TestDatabase;
let fixture: IsolationFixture;
let dataDir: string;

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
});

afterAll(async () => {
  await test.dispose();
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-secrets-"));
  await test.db.secretsKeyCheck.deleteMany();
  await test.db.secret.deleteMany();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const checkRows = () => test.db.secretsKeyCheck.findMany({ orderBy: { keyVersion: "asc" } });

/** The environment a server process gets: this one's, without any OSTRA_ setting of the developer's. */
const serverEnv = (settings: Record<string, string>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_") && name !== "DATABASE_URL")),
  NODE_ENV: "test",
  ...settings,
});

describe("the secrets key's check at start (Q136)", () => {
  it("F-001: an empty database starts and stores the check, and the same key starts again", async () => {
    const first = await openSecretStore(test.db, { secretsKey: null, dataDir }, context);
    const stored = await checkRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.keyVersion).toBe(1);
    // The check holds no readable value.
    expect(Buffer.from(stored[0]?.ciphertext ?? []).toString("utf8")).not.toContain("ostra");

    // A secret put now is one the next start reads: the same key, from the same data folder.
    const ref = await first.put({ organizationId: fixture.a.organization.id, purpose: "test.token" }, "a-stored-value");
    expect(ref.ok).toBe(true);
    const again = await openSecretStore(test.db, { secretsKey: null, dataDir }, context);
    expect(await checkRows()).toEqual(stored);
    if (ref.ok) {
      const read = await again.get(fixture.a.organization.id, ref.value);
      expect(read.ok && read.value).toBe("a-stored-value");
    }
  });

  it("F-001: another key refuses to start, with the message, and changes nothing", async () => {
    await openSecretStore(test.db, { secretsKey: null, dataDir }, context);
    const before = await checkRows();
    const keptKey = await readFile(path.join(dataDir, SECRETS_KEY_FILE), "utf8");

    // A second server process with a data folder of its own: it generates another key.
    const otherDir = await mkdtemp(path.join(tmpdir(), "ostra-secrets-other-"));
    try {
      const refused = openSecretStore(test.db, { secretsKey: null, dataDir: otherDir }, context);
      await expect(refused).rejects.toMatchObject({ name: SECRETS_KEY_MISMATCH });
      await expect(openSecretStore(test.db, { secretsKey: generateSecretsKey(), dataDir }, context)).rejects.toThrow(
        SECRETS_KEY_MISMATCH_MESSAGE,
      );
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
    expect(SECRETS_KEY_MISMATCH_MESSAGE).toContain("OSTRA_SECRETS_KEY");
    expect(SECRETS_KEY_MISMATCH_MESSAGE).toContain("secrets-key");
    // Nothing changed: the check, the secrets and the kept key are as they were.
    expect(await checkRows()).toEqual(before);
    expect(await test.db.secret.count()).toBe(0);
    expect(await readFile(path.join(dataDir, SECRETS_KEY_FILE), "utf8")).toBe(keptKey);
  });

  it("F-001: an install with secrets from before the check refuses a key that can't read them, and stores no check", async () => {
    const original = await openSecretStore(test.db, { secretsKey: null, dataDir }, context);
    await original.put({ organizationId: fixture.a.organization.id, purpose: "test.token" }, "an-old-value");
    // The install as it was before the check existed: its secrets, and no check row.
    await test.db.secretsKeyCheck.deleteMany();

    await expect(openSecretStore(test.db, { secretsKey: generateSecretsKey(), dataDir }, context)).rejects.toMatchObject({
      name: SECRETS_KEY_MISMATCH,
    });
    expect(await checkRows()).toHaveLength(0);
    // Its own key still starts, and stores the check then.
    await openSecretStore(test.db, { secretsKey: null, dataDir }, context);
    expect(await checkRows()).toHaveLength(1);
  });

  it("F-001: core's process refuses to start with another key, and says so with the two fixes", async () => {
    await openSecretStore(test.db, { secretsKey: null, dataDir }, context);
    const child = spawn(process.execPath, [path.join(here, "main.ts")], {
      env: serverEnv({ DATABASE_URL: test.url, OSTRA_DATA_DIR: dataDir, OSTRA_SECRETS_KEY: generateSecretsKey(), OSTRA_CORE_PORT: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.resume();
    // A core that started anyway is ended, so the test fails instead of hanging.
    const timer = setTimeout(() => child.kill(), 20_000);
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    clearTimeout(timer);
    expect(code).toBe(1);
    expect(stderr).toContain(SECRETS_KEY_MISMATCH_MESSAGE);
    expect(stderr).not.toContain("core is listening");
  });

  it("F-001: two processes racing on an empty database end with one check value that both read", async () => {
    const key = generateSecretsKey();
    const lineSchema = z.union([
      z.strictObject({ ready: z.literal(true) }),
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({ ok: z.literal(false), error: z.string() }),
    ]);
    type Child = { readonly process: ChildProcessWithoutNullStreams; readonly next: () => Promise<z.infer<typeof lineSchema>> };
    const start = (): Child => {
      const child = spawn(process.execPath, [path.join(here, "testing", "secrets-check-child.ts")], {
        env: serverEnv({ DATABASE_URL: test.url, OSTRA_DATA_DIR: dataDir, OSTRA_SECRETS_KEY: key }),
      });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      return {
        process: child,
        next: async () => {
          const line = await lines.next();
          if (line.done === true) {
            throw new Error("the check's process ended");
          }
          return lineSchema.parse(JSON.parse(line.value));
        },
      };
    };
    const children = [start(), start()];
    try {
      await Promise.all(children.map(async (child) => { expect(await child.next()).toEqual({ ready: true }); }));
      // Several rounds, each on an empty database: both processes start their check at once.
      for (let round = 0; round < 6; round += 1) {
        await test.db.secretsKeyCheck.deleteMany();
        for (const child of children) {
          child.process.stdin.write("check\n");
        }
        const outcomes = await Promise.all(children.map((child) => child.next()));
        expect(outcomes, `round ${String(round)}`).toEqual([{ ok: true }, { ok: true }]);
        expect(await checkRows()).toHaveLength(1);
      }
      // And both read the one value left: a second check of each matches it.
      const left = await checkRows();
      for (const child of children) {
        child.process.stdin.write("check\n");
      }
      expect(await Promise.all(children.map((child) => child.next()))).toEqual([{ ok: true }, { ok: true }]);
      expect(await checkRows()).toEqual(left);
    } finally {
      for (const child of children) {
        child.process.stdin.end("exit\n");
      }
      await Promise.all(
        children.map((child) =>
          child.process.exitCode === null ? new Promise((resolve) => child.process.once("exit", resolve)) : Promise.resolve(),
        ),
      );
    }
  });
});
