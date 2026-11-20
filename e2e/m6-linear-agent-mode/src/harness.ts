// `pnpm e2e:linear-agent-mode` (milestone 6's ticket 38, F-012, ADR 0013): spike 5's real run
// (`spikes/linear-agent-mode/src/real-run.ts`), against ostra itself on real Linear (`ostra-test`,
// team OST). It loads `linear.env` and `tunnel.env` from `~/.config/ostra-dev/`.
//
// - **No app token:** without `LINEAR_REFRESH_TOKEN` (ticket 40's step 1, the maintainer's Authorize
//   click) it prints "skipped: no app token" and ends 0, before anything touches Linear.
// - **With it:** it refreshes the app's token and writes the rotated refresh token back to
//   `linear.env` (never printed), then starts its own stack (`pnpm dev:reset --yes` on this checkout,
//   the database, core and the panel, on ports of its own) behind the maintainer's tunnel, which must
//   forward to the harness's core; sets the stack up as milestone 1's demo does (the first admin, the
//   stub model, the test App, a project on `test1`, renamed `agent-mode-load`); and seeds the app's
//   connection (`app_oauth`, the agent scopes) under `LINEAR_APP_CONNECTION_ID`, the ID in the app's
//   webhook URL, with "Start from Linear" on OST's board and outside approval on. Then the four
//   bullets: the install; 50 delegations with no runner online, then one bulk reject; a follow-up
//   (a thread reply by the key's user) and a stop a person presses (it waits 30 minutes, and reports
//   "not run" without one); and a silent turn of 35 minutes on the stub model, with a runner signed
//   in for it. The log (IDs, counts and times, never a token or ticket text) goes to
//   `.ostra-dev/e2e-linear-agent-mode/run.log`, and with `--record` to
//   `context/specs/m6-whole-team/demo/linear-agent-mode.log`. The tickets it made are archived.
//
// It has never run against real Linear: the token waits for the maintainer (ticket 40). Its
// phases, judges and ostra's side run in CI against core and the fake Linear (`rehearsal.test.ts`).

import { appendFile, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@ostra/db";
import { devDatabaseUrl, devDataDir } from "@ostra/db/dev";
import { demoGitHub } from "@ostra/e2e-m1/github";
import { addModelProvider, connectGitHub, createProject, loadState, say, signInAsAdmin } from "@ostra/e2e-m1/setup";
import { repoRoot } from "@ostra/e2e-m1/settings";
import { m2Settings } from "@ostra/e2e-m2/settings";
import { resetDevData, startStack } from "@ostra/e2e-m2-failures/stack";
import type { Stack } from "@ostra/e2e-m2-failures/stack";
import { marker, STUB_KEY, STUB_MODEL_ID, startStubModel } from "@ostra/e2e-m2-failures/stub-model";
import { addRunner } from "@ostra/e2e-m2-failures/world";
import { killAll } from "@ostra/e2e-m2-failures/procs";
import { createJobs } from "@ostra/jobs";
import { connectionIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { z } from "zod";

import { bulletOutcome } from "./judge.ts";
import { archiveIssues, linearApiUrl, readTeam } from "./linear-api.ts";
import type { LinearAccess } from "./linear-api.ts";
import { openStore, seedAgentModeBoard, seedAppConnection } from "./ostra-side.ts";
import type { OstraWorld } from "./ostra-side.ts";
import type { PhaseContext } from "./phases.ts";
import { readInstall, rotateAppToken, runBullets } from "./run.ts";
import { harnessSettings } from "./settings.ts";

const portsSchema = z.object({
  OSTRA_HARNESS_WEB_PORT: z.coerce.number().int().positive().default(3231),
  OSTRA_HARNESS_CORE_PORT: z.coerce.number().int().positive().default(8831),
  OSTRA_HARNESS_PG_PORT: z.coerce.number().int().positive().default(54431),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<number> => {
  const settings = await harnessSettings(process.env);
  if (settings.kind === "skip") {
    process.stdout.write(`skipped: ${settings.reason}\n`);
    return 0;
  }
  if (settings.kind === "incomplete") {
    process.stdout.write(`the live run needs these too (linear.env, tunnel.env): ${settings.missing.join(", ")}\n`);
    return 1;
  }
  const live = settings.settings;
  const stateDir = path.join(repoRoot, ".ostra-dev", "e2e-linear-agent-mode");
  await mkdir(stateDir, { recursive: true });
  const logFile = path.join(stateDir, "run.log");
  await rm(logFile, { force: true });
  const note = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    say(line);
    void appendFile(logFile, `${stamped}\n`).catch(() => undefined);
  };

  // The refresh comes first: the rotated refresh token is written back before anything can fail.
  const tokenUrl = process.env["OSTRA_HARNESS_LINEAR_TOKEN_URL"];
  const rotated = await rotateAppToken({ clientId: live.LINEAR_CLIENT_ID, clientSecret: live.LINEAR_CLIENT_SECRET, refreshToken: live.LINEAR_REFRESH_TOKEN, linearEnvFile: live.linearEnvFile, ...(tokenUrl === undefined ? {} : { tokenUrl }) });
  note(`the app's token refreshed; ${rotated.wroteBack ? "the rotated refresh token is written back to linear.env" : "Linear kept the refresh token"}`);
  const access: LinearAccess = { apiUrl: linearApiUrl(process.env), apiKey: live.LINEAR_API_KEY, appToken: rotated.tokens.accessToken, teamId: live.LINEAR_TEST_TEAM_ID };
  const install = await readInstall(access, rotated.tokens.scopes);

  const ports = portsSchema.parse(process.env);
  const portSet = { web: ports.OSTRA_HARNESS_WEB_PORT, core: ports.OSTRA_HARNESS_CORE_PORT, pg: ports.OSTRA_HARNESS_PG_PORT };
  if ([3000, 8787, 54329].some((port) => Object.values(portSet).includes(port))) {
    throw new Error("the harness never runs on the default ports (3000, 8787, 54329): another stack may be there");
  }
  const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_HARNESS_") && !["DATABASE_URL", "OSTRA_PUBLIC_URL", "OSTRA_CORE_PUBLIC_URL", "OSTRA_DEV_PUBLIC_URL"].includes(name) && !name.startsWith("LINEAR_")),
  );
  process.env["OSTRA_DEV_PG_PORT"] = String(portSet.pg);
  const panelUrl = `http://localhost:${String(portSet.web)}`;
  const m2 = m2Settings({
    OSTRA_DEV_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
    OSTRA_DEV_MODEL_API_KEY: "unused",
    OSTRA_DEV_MODEL_ID: "unused",
    ...process.env,
    LINEAR_API_KEY: live.LINEAR_API_KEY,
    LINEAR_TEST_TEAM_ID: live.LINEAR_TEST_TEAM_ID,
    LINEAR_TEST_TEAM_KEY: process.env["LINEAR_TEST_TEAM_KEY"] ?? "OST",
    OSTRA_E2E_PANEL_URL: panelUrl,
    OSTRA_E2E_CORE_URL: `http://127.0.0.1:${String(portSet.core)}`,
    OSTRA_PUBLIC_URL: panelUrl,
    OSTRA_ALLOW_DEFAULT_PASSWORD: "true",
  });
  const stub = await startStubModel();
  let stack: Stack | null = null;
  let browser: Browser | null = null;
  const made: string[] = [];
  const db = createDb(devDatabaseUrl(portSet.pg), { maxConnections: 6 });
  const jobs = createJobs({ databaseUrl: devDatabaseUrl(portSet.pg), role: "enqueue-only" });
  try {
    await resetDevData(baseEnv, portSet);
    const shared = { OSTRA_PUBLIC_URL: panelUrl, OSTRA_CORE_PUBLIC_URL: live.OSTRA_DEV_PUBLIC_URL, OSTRA_ALLOW_DEFAULT_PASSWORD: "true", OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true", OSTRA_CATALOG_FETCH: "false" };
    stack = await startStack({ ports: portSet, baseEnv, coreEnv: shared, webEnv: shared, logDir: path.join(stateDir, "logs") });
    const reached = await fetch(`${live.OSTRA_DEV_PUBLIC_URL}/healthz`, { signal: AbortSignal.timeout(15_000) }).then((response) => response.ok, () => false);
    if (!reached) throw new Error("the tunnel in tunnel.env doesn't reach the harness's core: point it at port " + String(portSet.core));
    note("the stack is up, and the tunnel reaches its core");
    browser = await chromium.launch();
    const page = await (await browser.newContext({ baseURL: panelUrl, viewport: { width: 1440, height: 900 } })).newPage();
    const demo = { ...m2, modelBaseUrl: stub.baseUrl, modelApiKey: STUB_KEY, modelId: STUB_MODEL_ID, coreUrl: stack.coreUrl, panelUrl };
    await signInAsAdmin(page, demo, await loadState(path.join(stateDir, "state.json")));
    await addModelProvider(page, demo);
    await connectGitHub(page, demo);
    const projectId = projectIdSchema.parse((await createProject(page, demo)).split("/").at(-1));
    await demoGitHub(demo);
    const project = await db.project.update({ where: { id: projectId }, data: { name: "agent-mode-load" }, select: { organizationId: true } });
    const organizationId = organizationIdSchema.parse(project.organizationId);
    const member = await db.member.findFirstOrThrow({ where: { organizationId }, orderBy: { createdAt: "asc" }, select: { id: true, userId: true } });
    const secretStore = openStore(db, (await readFile(path.join(devDataDir, "server", "secrets-key"), "utf8")).trim());
    await jobs.start();
    const world: OstraWorld = { db, jobs, secretStore, publicUrl: panelUrl, organizationId, projectId, member: { memberId: member.id, userId: member.userId } };
    const connectionId = await seedAppConnection(world, {
      connectionId: connectionIdSchema.parse(live.LINEAR_APP_CONNECTION_ID),
      clientId: live.LINEAR_CLIENT_ID,
      clientSecret: live.LINEAR_CLIENT_SECRET,
      webhookSecret: live.LINEAR_WEBHOOK_SECRET,
      accessToken: rotated.tokens.accessToken,
      refreshToken: rotated.tokens.refreshToken,
      expiresAt: rotated.tokens.expiresAt,
      scopes: rotated.tokens.scopes,
      appUser: { id: install.appUserId, name: install.appUserName },
      workspace: install.workspace,
    });
    const team = await readTeam(access);
    await seedAgentModeBoard(world, { connectionId, team, states: team.states });
    note(`the app's connection seeded (app_oauth, the agent scopes); Start from Linear on ${team.key}; outside approval on`);

    const context: PhaseContext = {
      world,
      connectionId,
      access,
      appUserId: install.appUserId,
      keyUserEmail: install.adminEmail,
      delegations: live.OSTRA_HARNESS_DELEGATIONS,
      note,
      made,
      pressStop: ({ identifier }) => {
        note(`A stop can't come from a key (ADR 0013). In Linear, open the agent session on ${identifier} and press "Send stop request": waiting up to ${String(live.OSTRA_HARNESS_STOP_WAIT_MINUTES)} minutes.`);
        return Promise.resolve();
      },
      stopWaitMs: live.OSTRA_HARNESS_STOP_WAIT_MINUTES * 60_000,
      // 60 reads, 30 s apart: a turn still running when the follow-up comes and when a person presses stop.
      workingTurn: { description: marker("slow", "agent-mode/working-turn.md 60 30000"), runner: true },
      silentTurn: {
        // The stub model's script: 70 reads, 30 s apart, then one write: 35 minutes of tool calls.
        description: marker("slow", "agent-mode/silent-turn.md 70 30000"),
        linearElapsed: (startedAt) => Date.now() - startedAt,
        wait: sleep,
        end: async (taskId) => {
          const deadline = Date.now() + 10 * 60_000;
          while (Date.now() < deadline) {
            const task = await db.task.findUnique({ where: { id: taskId }, select: { state: true } });
            if (task !== null && task.state !== "running" && task.state !== "queued" && task.state !== "preparing") return;
            await sleep(5_000);
          }
        },
      },
    };
    // A runner signed in when bullet 3 starts: bullet 2 has none online.
    const results = await runBullets(context, install, {
      beforeFollowUp: async () => {
        const liveStack = stack;
        if (liveStack === null) return;
        await addRunner({ m2: demo, page, db, runners: new Map(), stack: liveStack }, { name: "agent-mode-runner", dataDir: path.join(stateDir, "runner"), cut: null, logDir: path.join(stateDir, "logs") });
        note("a runner signed in for the follow-up's, the stop's and the silent turns");
      },
    });
    const failed = results.filter((result) => bulletOutcome(result.checks) === "fail").length;
    const notRun = results.filter((result) => bulletOutcome(result.checks) === "not-run").length;
    note(`linear agent-mode harness: ${failed === 0 && notRun === 0 ? "PASS" : failed > 0 ? "FAIL" : "NOT RUN (a bullet waited for a person)"}`);
    if (process.argv.includes("--record")) {
      const kept = path.join(repoRoot, "context", "specs", "m6-whole-team", "demo", "linear-agent-mode.log");
      await sleep(500);
      await copyFile(logFile, kept);
      note(`the log kept in ${path.relative(repoRoot, kept)}`);
    }
    return failed === 0 && notRun === 0 ? 0 : 1;
  } finally {
    const archived = await archiveIssues(access, made).catch(() => 0);
    note(`archived ${String(archived)} of the ${String(made.length)} tickets the run made`);
    await browser?.close().catch(() => undefined);
    await jobs.stop({ graceful: false, timeoutMs: 2_000 }).catch(() => undefined);
    await stack?.stop().catch(() => undefined);
    await killAll();
    await stub.close();
    await db.$disconnect();
  }
};

process.exitCode = await main();
