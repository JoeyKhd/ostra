import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createTestDatabase } from "@ostra/db/testing";
import type { TestDatabase } from "@ostra/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { freePort, spawnCore } from "./testing/restart.ts";

// Removed settings (docs/configuration.md): an install upgraded with an old env file that still
// sets OSTRA_OPEN_SIGNUP_* starts core anyway, and core says once, per setting, that it ignores it.
// Core runs as its own process, from the environment, as an install starts it.

let test: TestDatabase;
let dataDir: string;

beforeAll(async () => {
  test = await createTestDatabase();
  dataDir = await mkdtemp(path.join(tmpdir(), "ostra-retired-"));
});

afterAll(async () => {
  await test.dispose();
  await rm(dataDir, { recursive: true, force: true });
});

const logLineSchema = z.looseObject({ level: z.string(), msg: z.string(), setting: z.string().optional() });

/** A log line as JSON, or `null` for one that isn't (Node's own warnings share stderr). */
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

it("starts core's process with the retired OSTRA_OPEN_SIGNUP_* settings set, and logs one warning for each", async () => {
  const core = await spawnCore(
    {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_") && name !== "DATABASE_URL")),
      NODE_ENV: "test",
      DATABASE_URL: test.url,
      OSTRA_DATA_DIR: dataDir,
      OSTRA_SECRETS_KEY: generateSecretsKey(),
      OSTRA_CORE_PORT: String(await freePort()),
      OSTRA_GITHUB_API_URL: "http://127.0.0.1:1",
      OSTRA_CATALOG_FETCH: "false",
      OSTRA_OPEN_SIGNUP_ACCOUNTS: "true",
      OSTRA_OPEN_SIGNUP_ORGANIZATIONS: "on-for-strangers",
    },
    null,
  );
  try {
    expect((await fetch(`${core.url}/healthz`)).status).toBe(200);
    const warnings = core.logs.flatMap((line) => {
      const parsed = logLineSchema.safeParse(jsonOf(line));
      return parsed.success && parsed.data.msg === "settings.retired_ignored" ? [[parsed.data.level, parsed.data.setting]] : [];
    });
    expect(warnings).toEqual([
      ["warn", "OSTRA_OPEN_SIGNUP_ACCOUNTS"],
      ["warn", "OSTRA_OPEN_SIGNUP_ORGANIZATIONS"],
    ]);
    // Names only: the value an old env file gave is never logged.
    expect(core.logs.join("\n")).not.toContain("on-for-strangers");
  } finally {
    await core.kill();
  }
});
