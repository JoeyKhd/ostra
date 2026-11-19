// A server process's secrets-key check at start, as its own process (Q136, ticket 45): the race
// test starts two of these against one empty database. It connects, then waits for a line on
// stdin; each line runs the check once and prints one JSON line with the outcome. Settings come
// from the environment: DATABASE_URL, OSTRA_DATA_DIR and OSTRA_SECRETS_KEY. Prints no key.

import { createInterface } from "node:readline";

import { silentLogger, systemClock } from "@ostra/adapter-sdk";
import { createDb } from "@ostra/db";

import { openSecretStore } from "../secrets.ts";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const dataDir = process.env["OSTRA_DATA_DIR"] ?? "";
const secretsKey = process.env["OSTRA_SECRETS_KEY"] ?? null;

const db = createDb(databaseUrl);
await db.$connect();
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "exit") {
    break;
  }
  try {
    await openSecretStore(db, { secretsKey, dataDir }, { logger: silentLogger, clock: systemClock });
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.name : "unknown" })}\n`);
  }
}
await db.$disconnect();
