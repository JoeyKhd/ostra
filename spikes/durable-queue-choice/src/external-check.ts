// `pnpm check:external`: exercises the SPIKE_DATABASE_URL path of the harness against a real Postgres
// server that this script starts itself (embedded-postgres, in .data-external/, away from the
// harness's own .data/). It is not a pass-bar criterion: it checks the harness's own handling of a
// shared server, which `pnpm spike` cannot check about itself.
//
//   1. a run of C6 on the server passes, and leaves no database behind
//   2. a second run on the same server passes too (the first run's names do not collide with it)
//   3. a run whose template database already exists cannot start, exits non-zero without hanging,
//      and leaves the pre-existing database alone and no other
//   4. a generic DATABASE_URL in the environment is ignored: the harness starts its own embedded server

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { z } from "zod";
import { baseChildEnv } from "./child-env.ts";
import { startEmbeddedServer } from "./cluster.ts";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataRoot = join(projectRoot, ".data-external");

type HarnessRun = { readonly code: number | null; readonly stdout: string; readonly elapsedMs: number; readonly timedOut: boolean };

const runHarness = async (env: Record<string, string>, timeoutMs: number): Promise<HarnessRun> => {
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync(process.execPath, ["src/harness.ts"], {
      cwd: projectRoot,
      env: { ...baseChildEnv(), SPIKE_ONLY: "C6", ...env },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, elapsedMs: Date.now() - started, timedOut: false };
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "number" ? error.code : null;
    const killed = typeof error === "object" && error !== null && "killed" in error && error.killed === true;
    return { code, stdout, elapsedMs: Date.now() - started, timedOut: killed };
  }
};

const results: { readonly ok: boolean; readonly line: string }[] = [];
const check = (ok: boolean, line: string): void => {
  results.push({ ok, line });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${line}\n`);
};

const main = async (): Promise<number> => {
  const server = await startEmbeddedServer({ dataRoot, onLog: () => undefined });
  const admin = new pg.Client({ connectionString: server.adminUrl });
  try {
    await admin.connect();
    const userDatabases = async (): Promise<string[]> => {
      const result = await admin.query("SELECT datname FROM pg_database WHERE datname NOT IN ('postgres', 'template0', 'template1') ORDER BY datname");
      const rows: unknown = result.rows;
      return z
        .array(z.object({ datname: z.string() }))
        .parse(rows)
        .map((row) => row.datname);
    };

    for (const [number, label] of [
      [1, "the first run on the server"],
      [2, "a second run on the same server"],
    ] as const) {
      const run = await runHarness({ SPIKE_DATABASE_URL: server.adminUrl }, 300_000);
      const left = await userDatabases();
      check(
        run.code === 0 && !run.timedOut && /PASS\s+C6/.test(run.stdout) && left.length === 0,
        `${String(number)}. ${label}: exit ${String(run.code)} in ${(run.elapsedMs / 1000).toFixed(0)} s, C6 ${/PASS\s+C6/.test(run.stdout) ? "PASS" : "not PASS"}, ${String(left.length)} databases left behind${left.length > 0 ? ` (${left.join(", ")})` : ""}`,
      );
    }

    // 3. A start that fails part-way: the template's name is taken.
    const runId = "deadbeef";
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(`spike_${runId}_template`)}`);
    const collided = await runHarness({ SPIKE_DATABASE_URL: server.adminUrl, SPIKE_RUN_ID: runId }, 120_000);
    const afterCollision = await userDatabases();
    check(
      !collided.timedOut &&
        collided.code === 1 &&
        collided.stdout.includes("could not start Postgres") &&
        afterCollision.length === 1 &&
        afterCollision[0] === `spike_${runId}_template`,
      `3. a start that fails (the template's name is taken): ${collided.timedOut ? "HUNG until the timeout" : `exit ${String(collided.code)} after ${(collided.elapsedMs / 1000).toFixed(0)} s`}, ${String(afterCollision.length)} database(s) on the server afterwards (the pre-existing one is untouched: ${String(afterCollision[0] === `spike_${runId}_template`)})`,
    );
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(`spike_${runId}_template`)}`);

    // 4. A generic DATABASE_URL must never be used: here it points at a server that does not exist.
    const generic = await runHarness({ DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none" }, 300_000);
    check(
      generic.code === 0 && !generic.timedOut && generic.stdout.includes("starting embedded-postgres") && /PASS\s+C6/.test(generic.stdout),
      `4. a generic DATABASE_URL (pointing nowhere) is ignored: exit ${String(generic.code)}, the harness started its own embedded server and C6 ${/PASS\s+C6/.test(generic.stdout) ? "PASS" : "not PASS"}`,
    );
  } finally {
    await admin.end().catch(() => undefined);
    await server.stop().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => undefined);
  }
  return results.every((result) => result.ok) ? 0 : 1;
};

main()
  .then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5_000).unref();
  })
  .catch((error: unknown) => {
    process.stderr.write(`check:external crashed: ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exit(2);
  });
