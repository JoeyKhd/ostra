import path from "node:path";

import { say } from "@ostra/e2e-m1/setup";
import { marker } from "@ostra/e2e-m2-failures/stub-model";
import { poolIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { sleep, waitFor } from "./context.ts";
import type { Demo } from "./context.ts";
import { refusedRunner, startPoolRunner } from "./runners.ts";

// Spec section 3, steps 1 to 5: a pool that requires approval, a runner that joins and waits for
// it, a token's rotation, the fleet view, and the box sizes. The pool and the approval are made in
// Demo's browser; the runners are the installed CLI, each on its own core replica.

const createdSchema = z.object({ taskId: taskIdSchema });

/** A prompt task in `projectId` that the stub model plays as `steps` reads `ms` apart, then a write. */
export const promptTask = async (d: Demo, input: { readonly projectId: string; readonly title: string; readonly steps: number; readonly ms: number; readonly agentProfileId?: string; readonly as?: "demo" | "sam"; readonly runnerId?: string }): Promise<TaskId> => {
  const file = `fleet-demo/${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${String(Date.now()).slice(-6)}.md`;
  const api = input.as === "sam" ? d.samApi : d.api;
  const made = createdSchema.parse(
    await api.mutate("tasks.create", {
      projectId: input.projectId,
      title: input.title,
      prompt: `${marker("slow", `${file} ${String(input.steps)} ${String(input.ms)}`)}\n\nThe fleet demo's task "${input.title}" (milestone 5, ticket 37).`,
      ...(input.agentProfileId === undefined ? {} : { agentProfileId: input.agentProfileId }),
      ...(input.runnerId === undefined ? {} : { runnerId: input.runnerId }),
    }),
  );
  d.made.taskIds.push(made.taskId);
  return made.taskId;
};

export const runnerByName = async (d: Demo, name: string) =>
  d.db.runner.findFirst({ where: { organizationId: d.organizationId, name }, orderBy: { createdAt: "desc" }, select: { id: true, state: true, joinTokenId: true, version: true, minor: true, labels: true, executor: true } });

export const auditCount = (d: Demo, action: string, entityId?: string): Promise<number> =>
  d.db.auditEntry.count({ where: { organizationId: d.organizationId, action, ...(entityId === undefined ? {} : { entityId }) } });

const coreUrl = (d: Demo, index: number): string => d.stack.coreUrls[index % d.stack.coreUrls.length] ?? "";

/** Step 1: `build-fleet`, approval on, at most 3 boxes, 30-day tokens; `test1` and `test2` list it. */
export const step1 = async (d: Demo): Promise<void> => {
  const page = d.demo;
  await page.goto("/organization/runners");
  await page.getByRole("button", { name: "New pool" }).click();
  await page.locator("#pool-name").fill("build-fleet");
  await page.locator("#pool-approval").click();
  await page.locator("#pool-max").fill("3");
  await d.shot(page, "01-new-pool");
  await page.getByRole("button", { name: "Create pool" }).click();
  const shown = page.getByTestId("join-token");
  await shown.waitFor({ timeout: 30_000 });
  const token = (await shown.textContent())?.trim() ?? "";
  d.secrets.push(token);
  const command = (await page.getByTestId("join-command").innerText()).trim();
  d.check(1, "the token is shown once, with the ways to start a runner", token.length > 20 && !command.includes(token) && command.includes('OSTRA_JOIN_TOKEN'), "the join command reads the token from a variable or a file, never from the line");
  // The token's value is masked in the committed screenshot.
  await page.screenshot({ path: path.join(d.settings.screenshotDir, "01-join-token.png"), mask: [shown] });
  await page.getByRole("button", { name: "Done" }).click();
  const pool = await d.db.runnerPool.findFirstOrThrow({ where: { organizationId: d.organizationId, name: "build-fleet" }, select: { id: true, requiresApproval: true, maxBoxes: true, joinTokenDays: true } });
  const defaultPool = await d.db.runnerPool.findFirstOrThrow({ where: { organizationId: d.organizationId, isDefault: true }, select: { id: true } });
  const firstToken = await d.db.joinToken.findFirstOrThrow({ where: { poolId: pool.id }, select: { id: true, expiresAt: true } });
  const days = firstToken.expiresAt === null ? null : Math.round((firstToken.expiresAt.getTime() - Date.now()) / 86_400_000);
  d.check(1, "build-fleet requires approval, holds at most 3 boxes, and its token lasts 30 days", pool.requiresApproval && pool.maxBoxes === 3 && days === 30, `requiresApproval ${String(pool.requiresApproval)}, maxBoxes ${String(pool.maxBoxes)}, token lasts ${String(days)} days`);
  d.facts["poolId"] = pool.id;
  d.facts["defaultPoolId"] = defaultPool.id;
  d.facts["token1"] = firstToken.id;
  d.facts["token1Value"] = token;
  // test1: build-fleet then Default, a share of 2 boxes of build-fleet, small by default. test2: build-fleet then Default.
  await d.api.mutate("projects.setPools", { projectId: d.test1.id, pools: [{ poolId: pool.id, maxBoxes: 2 }, { poolId: defaultPool.id, maxBoxes: null }] });
  await d.api.mutate("projects.setDefaultBoxSize", { projectId: d.test1.id, size: "small" });
  await d.api.mutate("projects.setPools", { projectId: d.test2.id, pools: [{ poolId: pool.id, maxBoxes: null }, { poolId: defaultPool.id, maxBoxes: null }] });
  await page.goto(`${d.test1.href}/settings/runners`);
  const rows = page.getByTestId("project-pool-row");
  await rows.first().waitFor();
  const order = await rows.allInnerTexts();
  const share = await page.getByLabel("test1's share of build-fleet").inputValue().catch(() => "");
  d.check(
    1,
    "test1's Runners tab lists build-fleet, then the default pool, with its share of 2",
    order.length === 2 && (order[0] ?? "").includes("build-fleet") && /default/i.test(order[1] ?? "") && share === "2",
    `${order.map((row) => row.replaceAll(/\s+/g, " ").trim()).join(" → ")}; share ${share}`,
  );
  await d.shot(page, "01-test1-runners");
};

/** Step 2: `build-01` joins with labels `tier:fast` and waits; Demo approves it. */
export const step2 = async (d: Demo): Promise<void> => {
  const token = d.facts["token1Value"] ?? "";
  const runner = await startPoolRunner({ cli: d.cli, name: "build-01", dataDir: path.join(d.settings.runnersDir, "build-01"), logDir: d.logDir, serverUrl: coreUrl(d, 0), executor: "host", joinToken: token, labels: ["tier:fast"] });
  d.runners.set("build-01", runner);
  await runner.connecting;
  const joined = await waitFor("build-01's row", 60_000, async () => runnerByName(d, "build-01"));
  d.facts["build01"] = joined.id;
  d.check(2, "build-01 is joining", joined.state === "joining", `state ${joined.state}`);
  const audit = await d.db.auditEntry.findFirst({ where: { organizationId: d.organizationId, action: "runner.joined", entityId: joined.id }, select: { data: true } });
  d.check(2, "the audit log has runner.joined naming the token", audit !== null && JSON.stringify(audit.data).includes(d.facts["token1"] ?? "-"), audit === null ? "no entry" : "runner.joined with the token's ID");
  const notice = await waitFor("the join notice to Demo", 60_000, async () => d.db.notification.findFirst({ where: { organizationId: d.organizationId, kind: "runner_awaiting_approval" }, select: { id: true } }));
  d.check(2, "Demo has the notice that build-01 wants to join", true, `notification ${notice.id}`);
  await d.demo.goto("/needs-you");
  const row = d.demo.locator('[data-runner-approval="build-01"]');
  await row.waitFor({ timeout: 30_000 });
  d.check(2, "Needs you says build-01 wants to join build-fleet", (await row.innerText()).includes("build-01 wants to join build-fleet"), (await row.innerText()).split("\n")[0] ?? "");
  await row.getByRole("button", { name: "Review" }).click();
  const panel = d.demo.getByTestId("runner-approval");
  await panel.getByText("tier:fast").waitFor();
  const facts = await panel.innerText();
  d.check(2, "the review shows its host, system, executor, labels, version and token", ["Host", "System", "Executor", "host", "tier:fast", `v${d.cli.version}`, "Join token"].every((word) => facts.includes(word)), facts.replaceAll(/\s+/g, " ").slice(0, 240));
  await d.shot(d.demo, "02-runner-approval");
  // A task in test1 isn't offered to a runner that waits for approval.
  const taskId = await promptTask(d, { projectId: d.test1.id, title: "Waits for an approved runner", steps: 1, ms: 500 });
  d.facts["step2Task"] = taskId;
  await sleep(8000);
  const leases = await d.db.lease.count({ where: { taskId } });
  d.check(2, "a task in test1 isn't offered to the joining runner", leases === 0, `${String(leases)} leases while build-01 waits`);
  await panel.getByRole("button", { name: "Approve" }).click();
  await panel.getByTestId("approval-receipt").waitFor({ timeout: 30_000 });
  const online = await waitFor("build-01 online", 60_000, async () => {
    const row2 = await runnerByName(d, "build-01");
    return row2?.state === "online" ? row2 : null;
  });
  d.check(2, "after Approve, build-01 is online and the audit log has runner.approved", online.state === "online" && (await auditCount(d, "runner.approved", joined.id)) === 1, "online, runner.approved");
  const lease = await waitFor("the waiting task's lease", 60_000, async () => d.db.lease.findFirst({ where: { taskId }, select: { runnerId: true } }));
  d.check(2, "the task that waited goes to build-01 once it's approved", lease.runnerId === joined.id, "leased to build-01");
};

/** Step 3: a second token, the first revoked; build-01 stays; build-02 joins; revoked and expired tokens are refused. */
export const step3 = async (d: Demo): Promise<void> => {
  const poolId = poolIdSchema.parse(d.facts["poolId"]);
  const second = z.object({ joinTokenId: z.string(), token: z.string() }).parse(await d.api.mutate("joinTokens.create", { poolId, label: "rotation", days: 30 }));
  d.secrets.push(second.token);
  await d.api.mutate("joinTokens.revoke", { tokenId: d.facts["token1"] });
  await sleep(3000);
  const build01 = await runnerByName(d, "build-01");
  const presence = await d.db.runnerPresence.findUnique({ where: { runnerId: d.facts["build01"] ?? "" }, select: { disconnectedAt: true } });
  d.check(3, "revoking the first token leaves build-01 connected", build01?.state === "online" && presence?.disconnectedAt === null, `state ${build01?.state ?? "none"}`);
  const runner2 = await startPoolRunner({ cli: d.cli, name: "build-02", dataDir: path.join(d.settings.runnersDir, "build-02"), logDir: d.logDir, serverUrl: coreUrl(d, 1), executor: "host", joinToken: second.token });
  d.runners.set("build-02", runner2);
  await runner2.connecting;
  const joined = await waitFor("build-02's row", 60_000, async () => runnerByName(d, "build-02"));
  d.facts["build02"] = joined.id;
  await d.api.mutate("runners.approve", { runnerId: runnerIdSchema.parse(joined.id) });
  await waitFor("build-02 online", 60_000, async () => ((await runnerByName(d, "build-02"))?.state === "online" ? true : null));
  d.check(3, "build-02 joins with the second token and is approved", joined.joinTokenId === second.joinTokenId, "joined with the rotation token");
  const revoked = await refusedRunner({ cli: d.cli, name: "build-revoked", dataDir: path.join(d.settings.runnersDir, "build-revoked"), logDir: d.logDir, serverUrl: coreUrl(d, 2), executor: "host", joinToken: d.facts["token1Value"] ?? "" });
  // The spec's words are "This join token was revoked"; the runner says it as ticket 19 has it, with the fix.
  d.check(3, "a runner with the revoked token is refused, saying it was revoked", revoked !== null && revoked.code !== 0 && revoked.output.includes("(revoked): it was revoked"), revoked === null ? "it kept running" : `exit ${String(revoked.code)}: ${revoked.output.split("\n").find((line) => line.includes("join token")) ?? "(no reason printed)"}`);
  const expiring = z.object({ joinTokenId: z.string(), token: z.string() }).parse(await d.api.mutate("joinTokens.create", { poolId, label: "short", days: 1 }));
  d.secrets.push(expiring.token);
  // The script moves the token past its lifetime.
  await d.db.joinToken.update({ where: { id: expiring.joinTokenId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const expired = await refusedRunner({ cli: d.cli, name: "build-expired", dataDir: path.join(d.settings.runnersDir, "build-expired"), logDir: d.logDir, serverUrl: coreUrl(d, 0), executor: "host", joinToken: expiring.token });
  d.check(3, "a runner with an expired token is refused, saying it expired", expired !== null && expired.code !== 0 && expired.output.includes("(expired): it has expired"), expired === null ? "it kept running" : `exit ${String(expired.code)}: ${expired.output.split("\n").find((line) => line.includes("join token")) ?? "(no reason printed)"}`);
  const strays = await d.db.runner.count({ where: { organizationId: d.organizationId, name: { in: ["build-revoked", "build-expired"] } } });
  d.check(3, "neither refused runner appears as a runner", strays === 0, `${String(strays)} rows`);
};

/** Step 4: the fleet view and build-fleet's page. */
export const step4 = async (d: Demo): Promise<void> => {
  const page = d.demo;
  await page.goto("/organization/runners");
  const pools = page.getByRole("table").first();
  await pools.getByRole("link", { name: "build-fleet", exact: true }).waitFor({ timeout: 30_000 });
  const poolRow = await page.getByRole("row").filter({ hasText: "build-fleet" }).first().innerText();
  d.check(4, "Runners lists build-fleet as not isolated, same user (development only)", poolRow.includes('not isolated'), poolRow.replaceAll(/\s+/g, " ").slice(0, 160));
  await d.shot(page, "04-runners");
  await page.goto(`/organization/runners/pools/${d.facts["poolId"] ?? ""}`);
  // Each part as it loads: the runners, the tokens (the revoked one struck through and dated), the queue.
  const listed = await Promise.all(
    ["build-01", "build-02"].map((name) =>
      page
        .locator(`[data-runner="${name}"]`)
        .first()
        .waitFor({ timeout: 30_000 })
        .then(
          () => name,
          () => `no ${name}`,
        ),
    ),
  );
  const revokedToken = page.getByTestId("join-tokens").locator("li").filter({ hasText: /revoked \d+/ }).first();
  const marked = await revokedToken.waitFor({ timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  const queue = (await page.getByRole("region", { name: "Queue" }).innerText().catch(() => "")).replaceAll(/\s+/g, " ");
  d.check(
    4,
    "build-fleet's page lists both runners, its join tokens with the revoked one marked, and its empty queue",
    listed.every((one) => !one.startsWith("no ")) && marked && /nothing waiting/i.test(queue),
    `${listed.join(", ")}; revoked token: ${marked ? (await revokedToken.innerText()).replaceAll(/\s+/g, " ") : "not marked"}; queue: ${queue.slice(0, 80)}`,
  );
  await d.shot(page, "04-pool");
};

/** Step 5: Organization, Box sizes; large set to 8 vCPU and 32 GB. */
export const step5 = async (d: Demo): Promise<void> => {
  const page = d.demo;
  await page.goto("/organization/box-sizes");
  await page.getByRole("heading", { level: 1, name: "Box sizes" }).waitFor();
  const note = await page.getByTestId("box-sizes-host-note").innerText();
  const small = await page.getByLabel("small: vCPU").inputValue();
  const smallMemory = await page.getByLabel("small: memory in GiB").inputValue();
  d.check(5, "small is 2 vCPU and 4 GB, and host counts slots only", small === "2" && smallMemory === "4" && note.includes("host runners count slots only."), `small ${small} vCPU · ${smallMemory} GiB`);
  await page.getByLabel("large: memory in GiB").fill("32");
  await page.getByRole("button", { name: "Save sizes" }).click();
  await page.getByRole("status").filter({ hasText: "Saved. New boxes get these sizes." }).waitFor({ timeout: 30_000 });
  const large = await d.db.boxSize.findFirstOrThrow({ where: { organizationId: d.organizationId, name: "large" }, select: { cpuMillis: true, memoryMiB: true } });
  d.check(5, "large is 8 vCPU and 32 GB, and the audit log has it", large.cpuMillis === 8000 && large.memoryMiB === 32 * 1024 && (await auditCount(d, "box-size.updated")) >= 1, `${String(large.cpuMillis)} m · ${String(large.memoryMiB)} MiB`);
  await d.shot(page, "05-box-sizes");
  say("step 5: done");
};
