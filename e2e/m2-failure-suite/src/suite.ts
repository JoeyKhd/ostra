// `pnpm e2e:m2:failures` (ticket 38, F-048): milestone 2's failure suite, spec section 3's table,
// on this machine. It starts a stack of its own from an empty data folder (the database, core and
// the panel, each its own process, on the suite's ports), a cloudflared tunnel to core for Linear's
// webhooks, the stub model, and the fault proxies in front of Linear and GitHub. It sets the stack
// up as milestone 1's and 2's demos do (the first admin, the model provider, the test App, the
// project on `test1`, the Linear connection from the maintainer's key, team OST attached), signs in
// one personal runner on the `host` executor behind the cut proxy, and runs every case, one at a time
// (ticket 41's case signs in one more, and revokes it). Each case states what it does, does it, and checks it; the result and the timings go to
// `.ostra-dev/e2e-m2-failures/result.json`. `--long` adds the 11-minute cut; `--only a,b` runs those
// cases; `--keep` leaves the run's tickets, PRs and branches for a look.
//
// Secrets come from the environment (github.env, github-test.env, linear.env) and are typed into
// forms or kept in the stack's secret store only: never printed.

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDb } from "@ostra/db";
import { devDatabaseUrl, devDataDir } from "@ostra/db/dev";
import { checkNoCredential } from "@ostra/e2e-m1/checks";
import type { CheckResult } from "@ostra/e2e-m1/checks";
import { demoGitHub } from "@ostra/e2e-m1/github";
import { addModelProvider, connectGitHub, createProject, loadState, say, signInAsAdmin } from "@ostra/e2e-m1/setup";
import { linearTool } from "@ostra/e2e-m2/linear";
import { removeSeedWebhook, seedLinear } from "@ostra/e2e-m2/seed-linear";
import { organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";

import type { CaseResult } from "./cases/case.ts";
import { cutCase, longCutCase } from "./cases/cut-cases.ts";
import { revokeRunnerCase } from "./cases/revoke-case.ts";
import { killAgentCase, killRunnerCase, loseBoxCase, unstorableCase } from "./cases/runner-cases.ts";
import { scheduleHuntCase } from "./cases/schedule-hunt-case.ts";
import { coreFakesCase, dropWebhooksCase, limitsCase, replayWebhooksCase, restartServerCase, retryLiveCase } from "./cases/server-cases.ts";
import { cleanUpRun } from "./clean-up.ts";
import { panelApi } from "./live/api.ts";
import { checkDeliveriesOnce } from "./live/checks.ts";
import { resetDevData, startStack } from "./live/stack.ts";
import type { Stack } from "./live/stack.ts";
import { STUB_KEY, STUB_MODEL_ID, startStubModel } from "./live/stub-model.ts";
import { addRunner, attachBoard, SUITE_WEBHOOK_LABEL } from "./live/world.ts";
import type { World } from "./live/world.ts";
import { suiteSettings } from "./settings.ts";
import { startCutProxy } from "./tools/cut-proxy.ts";
import type { CutProxy } from "./tools/cut-proxy.ts";
import { startFaultProxy } from "./tools/fault-proxy.ts";
import type { FaultProxy } from "./tools/fault-proxy.ts";
import { killAll } from "./tools/procs.ts";
import { cloudflaredPath, startTunnel, waitForTunnel } from "./tools/tunnel.ts";

/**
 * Ticket 38's working value was 20 minutes without `--long`, with the cuts side by side on runners of
 * their own. The cases now run one at a time, so the machine holds one case's processes at once
 * (2026-11-19), and the two 5-minute cuts alone take 22 minutes: the working value is 45.
 */
const BUDGET_MINUTES = 45;
/** Milestone 6's schedule hunt (ticket 37) adds about 25 minutes of its own: the bar with it. */
const HUNT_MINUTES = 25;

const main = async (): Promise<void> => {
  const startedAt = Date.now();
  const settings = suiteSettings(process.env, process.argv);
  const wanted = (name: string): boolean => settings.only.length === 0 || settings.only.some((one) => name.startsWith(one));
  // What the stack reads, and nothing of the suite's own: the server refuses an OSTRA_* it doesn't know.
  const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_E2E_") && !name.startsWith("OSTRA_FS_") && !["DATABASE_URL", "OSTRA_PUBLIC_URL", "OSTRA_CORE_PUBLIC_URL", "OSTRA_DEV_PUBLIC_URL"].includes(name)),
  );
  // The helpers shared with the demos read the stack's ports from this process's environment.
  process.env["OSTRA_DEV_PG_PORT"] = String(settings.ports.pg);
  process.env["OSTRA_RUNNER_CAPACITY"] = "12";

  say("failure suite: an empty data folder");
  await resetDevData(baseEnv, settings.ports);
  await rm(settings.runnersDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  const logDir = path.join(settings.stateDir, "logs");
  await mkdir(logDir, { recursive: true });

  const stub = await startStubModel();
  const faults: { linear: FaultProxy; github: FaultProxy } = { linear: await startFaultProxy("https://api.linear.app"), github: await startFaultProxy("https://api.github.com") };
  const tunnel = await startTunnel({ binary: cloudflaredPath(process.env), localUrl: `http://127.0.0.1:${String(settings.ports.core)}`, logFile: path.join(logDir, "tunnel.log") });
  const panelUrl = `http://localhost:${String(settings.ports.web)}`;
  const shared = {
    OSTRA_PUBLIC_URL: panelUrl,
    OSTRA_CORE_PUBLIC_URL: tunnel.url,
    OSTRA_ALLOW_DEFAULT_PASSWORD: "true",
    OSTRA_MODEL_ENDPOINT_ALLOW_PRIVATE: "true",
    OSTRA_CATALOG_FETCH: "false",
    OSTRA_RECONCILE_MINUTES: "1",
  };
  say("failure suite: the stack (the database, core, the panel)");
  const stack: Stack = await startStack({
    ports: settings.ports,
    baseEnv,
    coreEnv: { ...shared, OSTRA_GITHUB_API_URL: faults.github.url, CORE_TEST_LINEAR_API_URL: `${faults.linear.url}/graphql` },
    webEnv: shared,
    logDir,
  });
  await waitForTunnel(tunnel.url, "/healthz");
  say("failure suite: the stack is up and the tunnel reaches core");

  const db = createDb(devDatabaseUrl(settings.ports.pg), { maxConnections: 4 });
  const tool = linearTool(settings.m2.linearApiKey);
  const m2 = { ...settings.m2, modelBaseUrl: stub.baseUrl, modelApiKey: STUB_KEY, modelId: STUB_MODEL_ID, coreUrl: stack.coreUrl, panelUrl };
  const github = await demoGitHub(m2);
  let browser: Browser | null = null;
  let webhookId: string | null = null;
  const cutProxies: CutProxy[] = [];
  const results: CaseResult[] = [];
  const after: CheckResult[] = [];
  let world: World | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: panelUrl, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signInAsAdmin(page, m2, await loadState(path.join(settings.stateDir, "state.json")));
    await addModelProvider(page, m2);
    await connectGitHub(page, m2);
    const projectHref = await createProject(page, m2);
    const projectId = projectIdSchema.parse(projectHref.split("/").at(-1));
    const seeded = await seedLinear({
      db,
      tool,
      env: {},
      serverDataDir: path.join(devDataDir, "server"),
      apiKey: m2.linearApiKey,
      teamId: m2.linearTeamId,
      publicUrl: tunnel.url,
      webhookLabel: SUITE_WEBHOOK_LABEL,
    });
    webhookId = seeded.webhookId;
    await attachBoard(page, m2, projectHref);
    const board = await db.board.findFirstOrThrow({ where: { projectId }, select: { id: true } });
    world = {
      m2,
      db,
      api: panelApi(context.request, panelUrl),
      page,
      tool,
      github,
      stack,
      organizationId: organizationIdSchema.parse(seeded.organizationId),
      projectId,
      projectHref,
      connectionId: seeded.connectionId,
      boardId: board.id,
      faults,
      runners: new Map(),
      made: { tickets: [], taskIds: [] },
    };
    const live = world;
    // One personal runner, behind spike 6's cut proxy (it forwards untouched until a case cuts it).
    // Every case runs alone, one after another: a case's stack is this one stack and this one
    // runner, so the machine never holds more than one case's processes at a time.
    const proxy = await startCutProxy({ host: "127.0.0.1", port: settings.ports.core });
    cutProxies.push(proxy);
    const mainRunner = await addRunner(live, { name: "fs-main", dataDir: path.join(settings.runnersDir, "fs-main"), cut: proxy, logDir });
    say(`failure suite: set up in ${String(Math.round((Date.now() - startedAt) / 1000))} s; the cases, one at a time`);

    const lanes: { readonly name: string; readonly mode: "hold" | "reset"; readonly ms: number }[] = [
      { name: "cut-hold-30s", mode: "hold", ms: 30_000 },
      { name: "cut-reset-30s", mode: "reset", ms: 30_000 },
      { name: "cut-hold-5m", mode: "hold", ms: 5 * 60_000 },
      { name: "cut-reset-5m", mode: "reset", ms: 5 * 60_000 },
    ];
    if (wanted("core-on-fakes")) results.push(await coreFakesCase(path.join(logDir, "core-on-fakes.log")));
    // Milestone 6 (ticket 37): spike 8's schedule hunt against the scheduler tick, on core's own processes.
    if (wanted("schedule-hunt")) results.push(await scheduleHuntCase(logDir));
    if (wanted("kill-runner")) results.push(await killRunnerCase(live, mainRunner));
    if (wanted("kill-agent")) results.push(await killAgentCase(live, mainRunner));
    if (wanted("lose-box")) results.push(await loseBoxCase(live, mainRunner));
    if (wanted("unstorable")) results.push(await unstorableCase(live, mainRunner));
    if (wanted("retry-after-commit")) results.push(await retryLiveCase(live, mainRunner));
    if (wanted("revoke-runner")) results.push(await revokeRunnerCase(live, mainRunner, { dataDir: path.join(settings.runnersDir, "fs-revoke"), logDir }));
    for (const lane of lanes) {
      if (wanted(lane.name)) results.push(await cutCase(live, mainRunner, lane.mode, lane.ms));
    }
    if (settings.long && wanted("cut-hold-11m")) results.push(await longCutCase(live, mainRunner, 11 * 60_000));

    // The cases that restart core, then the replay of everything the inbox recorded.
    if (wanted("restart-server")) results.push(await restartServerCase(live, mainRunner));
    if (wanted("drop-webhooks")) results.push(await dropWebhooksCase(live, mainRunner));
    if (wanted("limits")) results.push(await limitsCase(live, mainRunner));
    if (wanted("replay-webhooks")) {
      const pr = await db.taskRepo.findFirst({ where: { organizationId: live.organizationId, prNumber: { not: null } }, orderBy: { createdAt: "asc" }, select: { prNumber: true } });
      if (pr?.prNumber !== null && pr !== null) results.push(await replayWebhooksCase(live, m2.githubWebhookSecret, { number: pr.prNumber }));
    }

    after.push(await checkDeliveriesOnce(live));
    const logs = [...stack.logFiles(), ...[...live.runners.values()].map((one) => one.logFile)];
    after.push(await checkNoCredential(m2, logs, [m2.linearApiKey]));
  } finally {
    const minutes = Math.round((Date.now() - startedAt) / 6000) / 10;
    const ok = results.length > 0 && results.every((one) => one.ok) && after.every((one) => one.ok);
    for (const one of after) say(`${one.ok ? "PASS" : "FAIL"} ${one.name}: ${one.detail}`);
    say(`failure suite: ${String(results.filter((one) => one.ok).length)} of ${String(results.length)} cases passed in ${String(minutes)} min${settings.long ? " (--long)" : ` (the bar: ${String(BUDGET_MINUTES + (wanted("schedule-hunt") ? HUNT_MINUTES : 0))} min)`}`);
    for (const one of results) say(`  ${one.ok ? "PASS" : "FAIL"} ${one.name} (${String(one.seconds)} s): ${one.row}`);
    await writeFile(path.join(settings.stateDir, "result.json"), JSON.stringify({ ok, minutes, long: settings.long, results, after }, null, 2)).catch(() => undefined);
    if (!ok) process.exitCode = 1;
    await browser?.close().catch(() => undefined);
    if (world !== null && !settings.keep) await cleanUpRun(world).catch((error: unknown) => {
        say(`clean-up: ${error instanceof Error ? error.message : String(error)}`);
      });
    await removeSeedWebhook(tool, webhookId).catch(() => undefined);
    for (const runner of world?.runners.values() ?? []) await runner.process.stop().catch(() => undefined);
    for (const proxy of cutProxies) await proxy.close();
    await stack.stop().catch(() => undefined);
    await killAll();
    await stub.close();
    await faults.linear.close();
    await faults.github.close();
    await db.$disconnect();
  }
};

await main();
