import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentDatabasePath, readAgentTotals, withinTolerance } from "./agent-tokens.ts";

describe("withinTolerance", () => {
  it("takes 2% of the larger count, either way round", () => {
    expect(withinTolerance(1000, 980)).toBe(true);
    expect(withinTolerance(980, 1000)).toBe(true);
    expect(withinTolerance(1000, 979)).toBe(false);
    expect(withinTolerance(0, 0)).toBe(true);
    expect(withinTolerance(0, 5)).toBe(false);
  });
});

describe("readAgentTotals", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ostra-e2e-tokens-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const databaseWith = async (statements: readonly string[]): Promise<string> => {
    const file = agentDatabasePath(path.join(dir, "agent"));
    await mkdir(path.dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    for (const statement of statements) database.exec(statement);
    database.close();
    return file;
  };

  it("reads the per-session totals", async () => {
    const file = await databaseWith([
      "CREATE TABLE session_v2 (id text, tokens_input integer, tokens_output integer)",
      "INSERT INTO session_v2 VALUES ('a', 1000, 200), ('b', 50, 5)",
    ]);
    expect(await readAgentTotals(file)).toEqual({ input: 1050, output: 205 });
  });

  it("reads the totals of the assistant messages when the database keeps them there", async () => {
    const file = await databaseWith([
      "CREATE TABLE message (id text, data text)",
      `INSERT INTO message VALUES ('1', '{"role":"assistant","tokens":{"input":700,"output":30}}'), ('2', '{"role":"user"}'), ('3', '{"role":"assistant","tokens":{"input":300,"output":10}}')`,
    ]);
    expect(await readAgentTotals(file)).toEqual({ input: 1000, output: 40 });
  });

  it("is null for a database it doesn't know, and for a missing one", async () => {
    const file = await databaseWith(["CREATE TABLE something (id text)"]);
    expect(await readAgentTotals(file)).toBeNull();
    expect(await readAgentTotals(path.join(dir, "missing.db"))).toBeNull();
  });
});
