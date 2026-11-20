import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { demoDatabase, judgeTaskInDatabase, runningClusterPort } from "./database.ts";
import type { DemoDatabase } from "./database.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ostra-e2e-db-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A `postmaster.pid` as Postgres writes it while it runs: the port is the fourth line. */
const writePid = async (port: string): Promise<string> => {
  const pgDir = path.join(dir, "pg");
  await mkdir(pgDir, { recursive: true });
  await writeFile(path.join(pgDir, "postmaster.pid"), `43668\r\n${pgDir}\r\n1795059756\r\n${port}\r\n\r\nlocalhost\r\n\r\nready   \r\n`);
  return pgDir;
};

describe("runningClusterPort", () => {
  it("reads the port of the cluster running in the folder", async () => {
    expect(await runningClusterPort(await writePid("54601"))).toBe(54601);
  });

  it("is null when no cluster runs there, or the file isn't one", async () => {
    expect(await runningClusterPort(path.join(dir, "none"))).toBeNull();
    expect(await runningClusterPort(await writePid("not a port"))).toBeNull();
    expect(await runningClusterPort(await writePid("70000"))).toBeNull();
  });
});

describe("demoDatabase", () => {
  it("F-089/c8: the demo's token checks read the stack's own cluster when only the panel and core URLs name the stack", async () => {
    // The failing live run: a stack on port 54601, the demo's shell without OSTRA_DEV_PG_PORT. The
    // checks read the default port's database, another stack's, and found the task's session nowhere.
    const found = await demoDatabase({ OSTRA_E2E_PANEL_URL: "http://localhost:3401", OSTRA_E2E_CORE_URL: "http://localhost:9001" }, await writePid("54601"));
    expect(found.address).toBe("127.0.0.1:54601/ostra");
    expect(found.source).toBe("the running dev cluster");
  });

  it("keeps the stack's own variables first", async () => {
    const pgDir = await writePid("54601");
    expect((await demoDatabase({ OSTRA_DEV_PG_PORT: "54901" }, pgDir)).address).toBe("127.0.0.1:54901/ostra");
    const named = await demoDatabase({ DATABASE_URL: "postgresql://user:hunter2@db.internal:5432/ostra", OSTRA_DEV_PG_PORT: "54901" }, pgDir);
    expect(named).toMatchObject({ address: "db.internal:5432/ostra", source: "DATABASE_URL" });
    expect(named.address).not.toContain("hunter2");
  });

  it("falls back to the default port with no cluster running here", async () => {
    expect(await demoDatabase({}, path.join(dir, "none"))).toMatchObject({ address: "127.0.0.1:54329/ostra", source: "the default port" });
  });
});

describe("judgeTaskInDatabase", () => {
  const database: DemoDatabase = { url: "postgresql://ostra:ostra@127.0.0.1:54329/ostra", address: "127.0.0.1:54329/ostra", source: "the default port" };

  it("passes the database that holds the task", () => {
    expect(() => { judgeTaskInDatabase("t-1", 1, database); }).not.toThrow();
  });

  it("stops the demo on a database without the task, saying where it looked", () => {
    expect(() => { judgeTaskInDatabase("t-1", 0, database); }).toThrow(/task t-1 isn't in the database at 127\.0\.0\.1:54329\/ostra \(from the default port\).*OSTRA_DEV_PG_PORT/);
  });
});
