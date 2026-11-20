import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { say } from "@ostra/e2e-m1/setup";
import { spawnChild } from "@ostra/e2e-m2-failures/procs";
import { PROTOCOL_MINOR, runnerIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { sleep, waitFor } from "./context.ts";
import type { Demo } from "./context.ts";
import { startPoolRunner } from "./runners.ts";
import { promptTask, runnerByName } from "./steps-pools.ts";
import { activeLease, firstLease, waitForEmptyPool } from "./steps-tasks.ts";
import { devToolSwitch } from "./stack.ts";

// Spec section 3, steps 9 to 11: drain, resume and revoke from the panel; runners one and two minors
// behind, built from earlier commits; and the HTTP fallback through the dev proxies.

const runnerState = async (d: Demo, id: string): Promise<string> => (await d.db.runner.findUniqueOrThrow({ where: { id }, select: { state: true } })).state;

const profileId = async (d: Demo, name: string): Promise<string> => (await d.db.agentProfile.findFirstOrThrow({ where: { organizationId: d.organizationId, name }, select: { id: true } })).id;

/** Step 9: Demo drains build-01 while it runs a task, the runner restarts still draining, Demo resumes it, then revokes build-02 mid-task. */
export const step9 = async (d: Demo): Promise<void> => {
  await waitForEmptyPool(d, 900_000);
  const build01 = d.facts["build01"] ?? "";
  const build02 = d.facts["build02"] ?? "";
  const fast = await profileId(d, "Fast");
  const running = await promptTask(d, { projectId: d.test2.id, title: "Runs through the drain", steps: 6, ms: 4000, agentProfileId: fast });
  await waitFor("its lease on build-01", 60_000, () => activeLease(d, running));
  const page = d.demo;
  await page.goto(`/organization/runners/${build01}`);
  await page.getByRole("button", { name: "Drain" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Drain" }).click();
  await page.getByTestId("runner-state").filter({ hasText: "draining" }).waitFor({ timeout: 30_000 });
  await d.shot(page, "09-draining");
  const next = await promptTask(d, { projectId: d.test2.id, title: "Waits for the resume", steps: 2, ms: 2000, agentProfileId: fast });
  const finished = await waitFor("the running task's turn to finish", 180_000, async () => {
    const turn = await d.db.turn.findFirst({ where: { taskId: running, endedAt: { not: null } }, select: { id: true } });
    return turn;
  }, 2000);
  await sleep(5000);
  d.check(9, "the drained runner's task finishes, and nothing new is offered to it", finished.id !== "" && (await firstLease(d, next)) === null, "the turn ended; the next Fast task waits");
  await page.goto("/organization/runners");
  const row = await page.locator('li[data-runner="build-01"]').innerText();
  d.check(9, "the fleet view shows build-01 draining", row.includes("draining"), row.replaceAll(/\s+/g, " ").slice(0, 160));
  // The script kills build-01's process and starts it again from its folder.
  const old = d.runners.get("build-01");
  await old?.stop();
  const restarted = await startPoolRunner({ cli: d.cli, name: "build-01", dataDir: path.join(d.settings.runnersDir, "build-01"), logDir: d.logDir, serverUrl: d.stack.coreUrls[0] ?? "", executor: "host", labels: ["tier:fast"] });
  d.runners.set("build-01", restarted);
  await restarted.connecting;
  await waitFor("build-01 connected again", 60_000, async () => ((await d.db.runnerPresence.findUnique({ where: { runnerId: build01 }, select: { disconnectedAt: true } }))?.disconnectedAt === null ? true : null));
  await sleep(3000);
  d.check(9, "restarted, build-01 reconnects still draining", (await runnerState(d, build01)) === "draining", await runnerState(d, build01));
  await page.goto(`/organization/runners/${build01}`);
  await page.getByRole("button", { name: "Resume" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Resume" }).click();
  await page.getByTestId("runner-state").filter({ hasText: "online" }).waitFor({ timeout: 30_000 });
  const lease = await waitFor("the waiting Fast task's lease", 60_000, () => firstLease(d, next));
  d.check(9, "resumed, build-01 is online and takes the next queued task", lease.runnerId === build01, "online; the Fast task runs on it");

  // Demo revokes build-02 while it runs a task.
  let onTwo: TaskId | null = null;
  for (let attempt = 1; attempt <= 4 && onTwo === null; attempt += 1) {
    const taskId = await promptTask(d, { projectId: d.test2.id, title: `Runs on build-02 ${String(attempt)}`, steps: 20, ms: 4000 });
    const got = await waitFor("its lease", 60_000, () => firstLease(d, taskId));
    if (got.runnerId === build02) onTwo = taskId;
  }
  if (onTwo === null) throw new Error("no task landed on build-02");
  await sleep(6000);
  await page.goto(`/organization/runners/${build02}`);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await page.getByTestId("runner-state").filter({ hasText: "revoked" }).waitFor({ timeout: 30_000 });
  const lost = await waitFor("the task to stop", 30_000, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: onTwo }, select: { state: true, stoppedReason: true } });
    return task.state === "stopped" ? task : null;
  });
  d.check(9, "revoking build-02 stops its task as runner_lost at once", lost.stoppedReason === "runner_lost", lost.stoppedReason ?? "none");
  await d.api.mutate("tasks.reopen", { taskId: onTwo, clientMessageId: randomUUID(), text: "Carry on where you were." });
  const reopened = await waitFor("the reopened task's lease", 120_000, () => d.db.lease.findFirst({ where: { taskId: onTwo, state: "active" }, select: { runnerId: true } }));
  d.check(9, "the task reopens on build-01", reopened.runnerId === build01, reopened.runnerId === build01 ? "build-01" : reopened.runnerId);
  const two = d.runners.get("build-02");
  const ended = two === undefined ? null : await Promise.race([two.child.exited, sleep(30_000).then(() => "running")]);
  const again = await startPoolRunner({ cli: d.cli, name: "build-02", dataDir: path.join(d.settings.runnersDir, "build-02"), logDir: d.logDir, serverUrl: d.stack.coreUrls[1] ?? "", executor: "host" });
  const second = await Promise.race([again.child.exited.then((code) => `exited ${String(code)}`), sleep(45_000).then(() => "still running")]);
  const presence = await d.db.runnerPresence.findUnique({ where: { runnerId: build02 }, select: { disconnectedAt: true } });
  d.check(9, "build-02 can't connect again", presence?.disconnectedAt !== null && second.startsWith("exited"), `first process: ${String(ended)}; started again: ${second}`);
  await again.stop();
  await d.shot(page, "09-revoked");
};

const runFile = (command: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: repoRoot, windowsHide: true, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`${path.basename(command)} ${args.slice(0, 2).join(" ")} failed: ${stderr.slice(-800)}`));
    });
  });
const runGit = (args: readonly string[]): Promise<string> => runFile("git", args);
const runNode = (args: readonly string[]): Promise<string> => runFile(process.execPath, args);

/**
 * The commit before the one that took the protocol to `minor`: the last runner that speaks
 * `minor - 1`. Read from git, so the demo follows the protocol as it moves on.
 */
const before = async (minor: number): Promise<string> => {
  const commits = (await runGit(["log", "--format=%H", "-S", `export const PROTOCOL_MINOR = ${String(minor)};`, "--", "packages/protocol/src/runner/version.ts"])).trim().split(/\r?\n/);
  const introduced = commits.at(-1);
  if (introduced === undefined || introduced === "") throw new Error(`no commit set protocol minor ${String(minor)}`);
  return (await runGit(["rev-parse", "--short=12", `${introduced}^`])).trim();
};

/**
 * Step 10: a runner one minor behind the server works and is marked so; one two minors behind is
 * refused with the fix and appears as outdated. Each is built from the commit before the protocol
 * reached the next minor (ticket 16's script, whose two build folders are named `milestone-4` and
 * `milestone-3` until the milestones are tagged).
 */
export const step10 = async (d: Demo): Promise<void> => {
  const builds = path.join(repoRoot, ".ostra-dev", "runner-builds");
  const minorOf = async (name: string): Promise<number | null> => {
    const text = await readFile(path.join(builds, name, "packages", "protocol", "src", "runner", "version.ts"), "utf8").catch(() => "");
    const match = /export const PROTOCOL_MINOR = (\d+);/.exec(text);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const server = PROTOCOL_MINOR;
  if ((await minorOf("milestone-4")) !== server - 1 || (await minorOf("milestone-3")) !== server - 2) {
    say(`step 10: build the runners at protocol 1.${String(server - 1)} and 1.${String(server - 2)}`);
    for (const name of ["milestone-4", "milestone-3"]) await runGit(["worktree", "remove", "--force", path.join(builds, name)]).catch(() => "");
    await runGit(["worktree", "prune"]);
    await runNode([path.join(repoRoot, "scripts", "build-runner-at.ts"), "--ref", `milestone-4=${await before(server)}`, "--ref", `milestone-3=${await before(server - 1)}`]);
  }
  const behindMinor = await minorOf("milestone-4");
  const oldMinor = await minorOf("milestone-3");
  if (behindMinor !== server - 1 || oldMinor !== server - 2) throw new Error(`the earlier runners didn't build at protocol 1.${String(server - 1)} and 1.${String(server - 2)}: node scripts/build-runner-at.ts --ref milestone-4=<commit> --ref milestone-3=<commit>`);
  const poolId = d.facts["poolId"] ?? "";
  const token = z.object({ token: z.string() }).parse(await d.api.mutate("joinTokens.create", { poolId, label: "older runners", days: 1 }));
  d.secrets.push(token.token);
  const start = async (name: string, build: string, extraEnv: Readonly<Record<string, string>> = {}) =>
    spawnChild({
      name,
      command: process.execPath,
      args: [path.join(builds, build, "apps", "runner", "src", "main.ts"), "runner", "--server", d.stack.coreUrls[0] ?? "", "--data-dir", path.join(d.settings.runnersDir, name), "--name", name, "--executor", "host"],
      cwd: path.join(builds, build),
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OSTRA_"))), OSTRA_JOIN_TOKEN: token.token, ...extraEnv },
      logFile: path.join(d.logDir, `runner-${name}.log`),
    });
  // Milestone 5's runner knows the development same-user switch for a `host` pool on this machine.
  const behind = await start("build-behind", "milestone-4", { OSTRA_DEV_HOST_POOL_SAME_USER: "true" });
  d.stopLater.push(() => behind.kill9());
  const row = await waitFor("build-behind's row", 120_000, () => runnerByName(d, "build-behind"));
  await d.api.mutate("runners.approve", { runnerId: runnerIdSchema.parse(row.id) });
  await waitFor("build-behind online", 60_000, async () => ((await runnerByName(d, "build-behind"))?.state === "online" ? true : null));
  const presence = await d.db.runnerPresence.findUnique({ where: { runnerId: row.id }, select: { minor: true } });
  await d.demo.goto("/organization/runners");
  const fleetRow = (await d.demo.locator('li[data-runner="build-behind"]').first().innerText()).replaceAll(/\s+/g, " ");
  await d.demo.goto(`/organization/runners/${row.id}`);
  const version = d.demo.getByTestId("row-version");
  await version.filter({ hasText: /one minor behind/i }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  const versionText = (await version.innerText()).replaceAll(/\s+/g, " ");
  d.check(
    10,
    `a runner at protocol 1.${String(server - 1)}, one minor behind the server's 1.${String(server)}, works and is marked so`,
    presence?.minor === server - 1 && fleetRow.includes("behind") && /one minor behind/i.test(versionText),
    `fleet: ${fleetRow.slice(0, 120)}; its page: ${versionText.slice(0, 120)}`,
  );
  await d.shot(d.demo, "10-one-minor-behind");
  await behind.kill9();
  // A runner two minors behind reads the server's window from `/runner/v1/info` before it signs in,
  // and stops itself with the fix: it never registers, so it has no row to mark outdated.
  const refused = await start("build-outdated", "milestone-3");
  const line = await refused.waitForLine((text) => text.includes(`protocol 1.${String(server - 2)}`), 120_000).catch(() => "");
  await refused.kill9();
  const window = `outside the server's window (protocol 1.${String(server - 1)} to 1.${String(server + 1)}). Install ostra`;
  d.check(10, `a runner at protocol 1.${String(server - 2)} is refused with the fix`, line.includes(`protocol 1.${String(server - 2)})`) && line.includes(window), line.trim().slice(0, 200));
  d.check(10, "the refused runner joins nothing", (await runnerByName(d, "build-outdated")) === null, "no runner row");
  d.note(
    10,
    "a refused runner shows as outdated only when it has a row, a runner that joined before the server moved on; one two minors behind stops before it signs in. The panel's outdated line is proved by apps/web/e2e/15-runner.spec.ts and core's refusal on both carriers by apps/core/src/gateway/version-matrix.test.ts (ticket 16).",
  );
  await d.demo.goto("/organization/runners");
  await d.shot(d.demo, "10-fleet-versions");
  d.note(10, "the pin (the CLI at N+1 installing N from the npm registry) is ticket 19's tests' (apps/runner/src/pin.test.ts): the dev npm registry serves stand-ins, not runners.");
};

const proxyReady = z.looseObject({ connect: z.number(), inspecting: z.number(), ca: z.string(), connectUrlFile: z.string() });

/** Step 11: build-03 behind a proxy that refuses WebSockets falls back to HTTP, steers reach it, and it goes back to WebSocket. */
export const step11 = async (d: Demo): Promise<void> => {
  const proxies = proxyReady.parse(d.tools.netProxies.ready);
  await devToolSwitch("e2e/m5-the-fleet/src/dev/net-proxies.ts", ["mode", "block"], d.toolEnv);
  const token = z.object({ token: z.string() }).parse(await d.api.mutate("joinTokens.create", { poolId: d.facts["poolId"] ?? "", label: "behind a proxy", days: 1 }));
  d.secrets.push(token.token);
  const at = Date.now();
  const runner = await startPoolRunner({
    cli: d.cli,
    name: "build-03",
    dataDir: path.join(d.settings.runnersDir, "build-03"),
    logDir: d.logDir,
    serverUrl: `https://ostra-core.test:${String(d.settings.ports.core)}`,
    executor: "host",
    joinToken: token.token,
    labels: ["net:proxied"],
    // The dev proxy knows only core: GitHub and the stub model are reached directly, as NO_PROXY says.
    env: { HTTPS_PROXY: `http://127.0.0.1:${String(proxies.inspecting)}`, NODE_EXTRA_CA_CERTS: proxies.ca, NO_PROXY: "github.com,.github.com,127.0.0.1,localhost" },
  });
  d.runners.set("build-03", runner);
  const row = await waitFor("build-03's row", 90_000, () => runnerByName(d, "build-03"));
  await d.api.mutate("runners.approve", { runnerId: runnerIdSchema.parse(row.id) });
  const http = await waitFor("build-03 on HTTP", 90_000, async () => {
    const presence = await d.db.runnerPresence.findUnique({ where: { runnerId: row.id }, select: { carrier: true, disconnectedAt: true, connectedAt: true } });
    return presence?.carrier === "http" && presence.disconnectedAt === null ? presence : null;
  });
  const seconds = Math.round((http.connectedAt.getTime() - at) / 1000);
  d.check(11, "behind the proxy that refuses WebSockets, build-03 is on HTTP within 30 s", seconds <= 30, `on HTTP ${String(seconds)} s after it started`);
  await d.demo.goto(`/organization/runners/${row.id}`);
  const carrierRow = d.demo.getByTestId("row-carrier");
  await carrierRow.filter({ hasText: "HTTP" }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  const carrier = (await carrierRow.innerText()).trim();
  d.check(11, "the fleet view shows its carrier as HTTP", carrier.includes("HTTP"), carrier);
  await d.shot(d.demo, "11-http-carrier");
  // A steer reaches its task, and every event is stored once.
  const profile = z.object({ profileId: z.string() }).parse(
    await d.api.mutate("agentProfiles.save", {
      name: "Proxied",
      adapter: "opencode",
      modelId: (await d.db.agentProfile.findFirstOrThrow({ where: { organizationId: d.organizationId, builtIn: true }, select: { modelId: true } })).modelId,
      instructions: null,
      approvalRules: [],
      planFirst: false,
      access: { kind: "everyone" },
      mcpServers: [],
      skills: [],
    }),
  );
  await d.api.mutate("agentProfiles.setRunnerLabels", { profileId: profile.profileId, labels: ["net:proxied"] });
  const taskId = await promptTask(d, { projectId: d.test2.id, title: "Behind the proxy", steps: 8, ms: 3000, agentProfileId: profile.profileId });
  await waitFor("the task's lease on build-03", 120_000, async () => ((await activeLease(d, taskId))?.runnerId === row.id ? true : null));
  await waitFor("the task's turn to start", 120_000, async () => ((await d.db.event.count({ where: { taskId, kind: "turn.started" } })) > 0 ? true : null));
  const message = randomUUID();
  await d.api.mutate("tasks.send", { taskId, clientMessageId: message, text: "Also mention the proxy in the file." });
  const steered = await waitFor("the steer to reach the agent", 120_000, async () => {
    const events = await d.db.event.findMany({ where: { taskId }, select: { kind: true, payload: true } });
    return events.some((event) => event.kind !== "member.message" && JSON.stringify(event.payload).includes(message)) ? true : null;
  }).catch(() => false);
  const seqs = await d.db.event.findMany({ where: { taskId }, select: { sessionId: true, seq: true } });
  const keys = seqs.map((event) => `${event.sessionId}:${String(event.seq)}`);
  d.check(11, "a steer reaches its task over HTTP, and every event is stored once", steered && new Set(keys).size === keys.length, `${String(keys.length)} events, ${String(new Set(keys).size)} distinct`);
  // The proxy passes WebSockets again: within the one-minute retry, the runner is back on one.
  await devToolSwitch("e2e/m5-the-fleet/src/dev/net-proxies.ts", ["mode", "pass"], d.toolEnv);
  const back = await waitFor("build-03 on WebSocket", 150_000, async () => {
    const presence = await d.db.runnerPresence.findUnique({ where: { runnerId: row.id }, select: { carrier: true, disconnectedAt: true } });
    return presence?.carrier === "websocket" && presence.disconnectedAt === null ? true : null;
  }, 2000).catch(() => false);
  d.check(11, "with WebSockets passed again, build-03 is back on WebSocket within the retry", back, back ? "websocket" : "still on HTTP");
  // Through the CONNECT proxy, with Basic auth, a runner of core behind TLS stays on WebSocket. The
  // proxy's URL, with its credentials, is read from the tool's file and never printed.
  const connectProxy = (await readFile(proxies.connectUrlFile, "utf8")).trim();
  d.secrets.push(decodeURIComponent(new URL(connectProxy).password));
  const viaConnect = await startPoolRunner({
    cli: d.cli,
    name: "build-04",
    dataDir: path.join(d.settings.runnersDir, "build-04"),
    logDir: d.logDir,
    serverUrl: `https://ostra-core.test:${String(d.settings.ports.core)}`,
    executor: "host",
    joinToken: token.token,
    env: { HTTPS_PROXY: connectProxy, NODE_EXTRA_CA_CERTS: proxies.ca, NO_PROXY: "github.com,.github.com,127.0.0.1,localhost" },
  });
  d.runners.set("build-04", viaConnect);
  const four = await waitFor("build-04's row", 90_000, () => runnerByName(d, "build-04"));
  await d.api.mutate("runners.approve", { runnerId: runnerIdSchema.parse(four.id) });
  const fourPresence = await waitFor("build-04 connected", 90_000, () => d.db.runnerPresence.findFirst({ where: { runnerId: four.id, disconnectedAt: null }, select: { carrier: true } }));
  await sleep(15_000);
  const still = await d.db.runnerPresence.findUnique({ where: { runnerId: four.id }, select: { carrier: true } });
  d.check(11, "through the CONNECT proxy, with Basic auth, a runner stays on WebSocket", fourPresence.carrier === "websocket" && still?.carrier === "websocket", still?.carrier ?? "none");
  await viaConnect.stop();
};
