import path from "node:path";

import { connectRunner, say } from "@ostra/e2e-m1/setup";
import { marker } from "@ostra/e2e-m2-failures/stub-model";
import { taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { sleep, waitFor } from "./context.ts";
import type { Demo } from "./context.ts";
import { auditCount, promptTask } from "./steps-pools.ts";

// Spec section 3, steps 6 to 8: capacity and the queue (shares, priority order, cancel), choosing a
// runner by labels, and a member's personal runner beside the pools.

const startedSchema = z.object({ taskId: taskIdSchema });

/** A ticket in OST at `priority` (Linear's: 1 Urgent … 4 Low) whose description is the stub's script, started as the Inbox starts one. */
export const ticketTask = async (d: Demo, input: { readonly title: string; readonly priority: number; readonly steps: number; readonly ms: number }): Promise<TaskId> => {
  const file = `fleet-demo/${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-${String(Date.now()).slice(-6)}.md`;
  const made = z
    .object({ issueCreate: z.object({ issue: z.object({ id: z.string(), identifier: z.string() }) }) })
    .parse(
      await d.tool.call("mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }", {
        input: {
          teamId: d.settings.m2.linearTeamId,
          title: `Fleet demo: ${input.title}`,
          priority: input.priority,
          description: `${marker("slow", `${file} ${String(input.steps)} ${String(input.ms)}`)}\n\nThe fleet demo's ticket (milestone 5, ticket 37).`,
        },
      }),
    ).issueCreate.issue;
  d.made.tickets.push({ id: made.id, identifier: made.identifier });
  // The connection polls every minute: the ticket reaches the cache within two.
  const ticket = await waitFor(`${made.identifier} in the ticket cache`, 180_000, () => d.db.ticket.findFirst({ where: { externalId: made.id, boardId: d.boardId }, select: { id: true } }), 2000);
  // As the Inbox's Start does: the same procedure.
  const started = startedSchema.parse(await d.api.mutate("tasks.startFromTicket", { projectId: d.test1.id, ticketId: ticket.id }));
  d.made.taskIds.push(started.taskId);
  return started.taskId;
};

export const activeLease = (d: Demo, taskId: TaskId) => d.db.lease.findFirst({ where: { taskId, state: "active" }, select: { runnerId: true, grantedAt: true } });
export const firstLease = (d: Demo, taskId: TaskId) => d.db.lease.findFirst({ where: { taskId }, orderBy: { grantedAt: "asc" }, select: { runnerId: true, grantedAt: true } });

/** The pool's boxes holding a slot now. */
const busyBoxes = (d: Demo): Promise<number> =>
  d.db.box.count({ where: { organizationId: d.organizationId, runner: { poolId: d.facts["poolId"] ?? "" }, state: { in: ["creating", "preparing", "ready", "idle"] } } });

/** Waits until build-fleet has no box holding a slot: every earlier task's box has stopped. */
export const waitForEmptyPool = async (d: Demo, timeoutMs = 300_000): Promise<void> => {
  await waitFor("build-fleet's boxes to stop", timeoutMs, async () => ((await busyBoxes(d)) === 0 ? true : null), 2000);
};

/** Step 6: five prompts and two tickets in test1, one prompt in test2; shares, the queue's order, cancel. */
export const step6 = async (d: Demo): Promise<void> => {
  await waitForEmptyPool(d);
  // The tickets first, so they're in the cache before the prompts take the slots; started after them.
  const prompts: TaskId[] = [];
  for (let index = 1; index <= 5; index += 1) prompts.push(await promptTask(d, { projectId: d.test1.id, title: `Queue prompt ${String(index)}`, steps: 16, ms: 5000 }));
  const urgent = await ticketTask(d, { title: "Urgent fix", priority: 1, steps: 4, ms: 3000 });
  const low = await ticketTask(d, { title: "Low tidy-up", priority: 4, steps: 2, ms: 2000 });
  const other = await promptTask(d, { projectId: d.test2.id, title: "test2 on the third slot", steps: 10, ms: 5000 });
  d.facts["urgent"] = urgent;
  d.facts["low"] = low;
  await sleep(8000);
  const running = await Promise.all([...prompts, urgent, low, other].map(async (taskId) => ((await activeLease(d, taskId)) === null ? 0 : 1)));
  const test1Running = running.slice(0, 7).reduce<number>((sum, one) => sum + one, 0);
  d.check(6, "test1 runs two, its share; test2's task runs on the third slot", test1Running === 2 && running[7] === 1 && running[0] === 1 && running[1] === 1, `test1 ${String(test1Running)} running, test2 ${String(running[7] ?? 0)}`);
  const page = d.demo;
  await page.goto(`/organization/runners/pools/${d.facts["poolId"] ?? ""}`);
  const rows = page.getByRole("region", { name: "Queue" }).locator("[data-queued]");
  await rows.first().waitFor({ timeout: 30_000 });
  const order = (await rows.allInnerTexts()).map((text) => text.replaceAll(/\s+/g, " "));
  const titles = order.map((text) => (text.includes("Urgent fix") ? "Urgent" : text.includes("Low tidy-up") ? "Low" : (/Queue prompt (\d)/.exec(text)?.[1] ?? "?")));
  // The step's own tasks, in their order. Other tasks can share the queue: since milestone 6 a code
  // task's PR starts an AI review task in its project (step 2's did), queued by the same rule.
  const own = titles.filter((title) => title !== "?");
  const others = titles.length - own.length;
  d.check(
    6,
    "the queue is the Urgent ticket, then the prompts in order, then the Low ticket",
    own.join(",") === "Urgent,3,4,5,Low",
    `${own.join(" → ")}${others === 0 ? "" : ` (the whole queue, with ${String(others)} other: ${titles.join(" → ")})`}`,
  );
  await d.shot(page, "06-pool-queue");
  await page.goto(`/tasks/${prompts[3] ?? ""}`);
  const waitLine = page.getByTestId("task-wait-line");
  // The line is whole once the project's name has loaded.
  await waitLine.filter({ hasText: "test1 is at its share" }).waitFor({ timeout: 30_000 });
  const line = (await waitLine.innerText()).replaceAll(/\s+/g, " ");
  const place = /\d+(?:st|nd|rd|th) in build-fleet's queue/.exec(line)?.[0] ?? "";
  d.check(6, "a queued task's page gives its place and why it waits", place === "3rd in build-fleet's queue" && line.includes("test1 is at its share of build-fleet: 2 boxes"), `${place}; ${/[^.]*share[^.]*/.exec(line)?.[0] ?? "(no reason)"}`);
  await d.shot(page, "06-task-queued");

  // Demo cancels the Low ticket's task from the pool's queue.
  await page.goto(`/organization/runners/pools/${d.facts["poolId"] ?? ""}`);
  const lowRow = page.getByRole("region", { name: "Queue" }).locator("[data-queued]").filter({ hasText: "Low tidy-up" });
  await lowRow.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel task" }).click();
  const cancelled = await waitFor("the Low ticket's task to stop", 30_000, async () => {
    const row = await d.db.task.findUnique({ where: { id: low }, select: { state: true, stoppedReason: true } });
    return row?.state === "stopped" ? row : null;
  });
  await page.goto(`/tasks/${low}`);
  const by = page.getByTestId("task-wait-line").filter({ hasText: "Cancelled by" });
  await by.waitFor({ timeout: 30_000 });
  const cancelledLine = (await by.innerText()).trim();
  d.check(
    6,
    "the Low ticket's task stops as Cancelled by Demo, and the audit log has task.cancelled",
    cancelled.stoppedReason === "cancelled" && (await auditCount(d, "task.cancelled", low)) === 1,
    `${cancelled.stoppedReason ?? "none"}; "${cancelledLine}"`,
  );
  await d.shot(page, "06-task-cancelled");

  // When a box frees, the Urgent ticket starts next.
  const urgentLease = await waitFor("the Urgent ticket's lease", 600_000, () => firstLease(d, urgent), 2000);
  const before = await Promise.all(prompts.slice(2).map((taskId) => firstLease(d, taskId)));
  const jumped = before.filter((lease) => lease !== null && lease.grantedAt < urgentLease.grantedAt).length;
  d.check(6, "when a box frees, the Urgent ticket starts next", jumped === 0, `${String(jumped)} queued prompts started before it`);
};

const saveProfile = async (d: Demo, name: string, labels: readonly string[]): Promise<string> => {
  const builtIn = await d.db.agentProfile.findFirstOrThrow({ where: { organizationId: d.organizationId, builtIn: true }, select: { modelId: true, adapter: true } });
  const saved = z
    .object({ profileId: z.string() })
    .parse(await d.api.mutate("agentProfiles.save", { name, adapter: builtIn.adapter, modelId: builtIn.modelId, instructions: null, approvalRules: [], planFirst: false, access: { kind: "everyone" }, mcpServers: [], skills: [] }));
  await d.api.mutate("agentProfiles.setRunnerLabels", { profileId: saved.profileId, labels: [...labels] });
  return saved.profileId;
};

/** Step 7: a profile asking for `tier:fast` runs on build-01 only; one asking for `gpu` waits with the reason; a task no member started goes to a pool. */
export const step7 = async (d: Demo): Promise<void> => {
  await waitForEmptyPool(d, 900_000);
  const fast = await saveProfile(d, "Fast", ["tier:fast"]);
  const gpu = await saveProfile(d, "GPU", ["gpu"]);
  const fastTasks: TaskId[] = [];
  for (let index = 1; index <= 2; index += 1) fastTasks.push(await promptTask(d, { projectId: d.test2.id, title: `Fast ${String(index)}`, steps: 3, ms: 2000, agentProfileId: fast }));
  const leases = await Promise.all(fastTasks.map((taskId) => waitFor("a Fast task's lease", 60_000, () => firstLease(d, taskId))));
  d.check(7, "tasks on Fast run on build-01 only, with build-02 free", leases.every((lease) => lease.runnerId === d.facts["build01"]), leases.map((lease) => (lease.runnerId === d.facts["build01"] ? "build-01" : lease.runnerId)).join(", "));
  const gpuTask = await promptTask(d, { projectId: d.test2.id, title: "Needs a GPU", steps: 1, ms: 500, agentProfileId: gpu });
  await sleep(6000);
  await d.demo.goto(`/tasks/${gpuTask}`);
  // The line names the project's pools once they've loaded.
  const reason = d.demo.getByTestId("task-wait-line").filter({ hasText: /No runner in build-fleet or default has the labels? gpu/i });
  await reason.waitFor({ timeout: 30_000 });
  const text = (await reason.innerText()).trim();
  d.check(7, "a task on a profile asking for gpu waits with the reason", /No runner in build-fleet or default has the labels? gpu/i.test(text), `"${text}"`);
  await d.shot(d.demo, "07-task-needs-gpu");
  await d.api.mutate("tasks.cancelQueued", { taskId: gpuTask });

  // A ticket task no member started (the source milestone 6's rules will use): queued while every
  // slot is busy, then stripped of its member, as ticket 14's helper makes one.
  for (let index = 1; index <= 3; index += 1) await promptTask(d, { projectId: d.test2.id, title: `Holds a slot ${String(index)}`, steps: 6, ms: 3000 });
  const system = await ticketTask(d, { title: "Started by the system", priority: 2, steps: 1, ms: 500 });
  const early = await firstLease(d, system);
  await d.db.task.update({ where: { id: system }, data: { creatorMemberId: null, driverMemberId: null, runnerId: null } });
  const lease = early ?? (await waitFor("the system task's lease", 600_000, () => firstLease(d, system), 2000));
  const runner = await d.db.runner.findUniqueOrThrow({ where: { id: lease.runnerId }, select: { kind: true, name: true } });
  d.check(7, "a task no member started goes to a pool runner", early === null && runner.kind === "pool", `${runner.name} (${runner.kind})${early === null ? "" : "; it was leased before the script cleared its member"}`);
};

/** Step 8: Sam's personal runner beside the pools. */
export const step8 = async (d: Demo): Promise<void> => {
  const samSettings = { ...d.settings.m2, coreUrl: d.stack.coreUrls[1] ?? d.settings.m2.coreUrl, runnerDataDir: path.join(d.settings.runnersDir, "sam"), runnerName: "sam-laptop", screenshotDir: path.join(d.settings.stateDir, "setup-shots") };
  // Sam's runner signs in with a device code, which Sam approves in the browser.
  const logFile = path.join(d.logDir, "runner-sam-laptop.log");
  const runner = await connectRunner(d.sam, samSettings, logFile);
  d.stopLater.push(runner.stop);
  const row = await waitFor("Sam's runner", 60_000, () => d.db.runner.findFirst({ where: { organizationId: d.organizationId, name: "sam-laptop", kind: "personal" }, select: { id: true } }));
  d.facts["samRunner"] = row.id;
  await d.sam.goto("/organization/runners");
  const facts = d.sam.getByTestId("machine-facts").filter({ hasText: "sam-laptop" });
  await facts.waitFor({ timeout: 30_000 });
  const line = (await facts.innerText()).replaceAll(/\s+/g, " ");
  d.check(
    8,
    "Sam's machine: connected, personal, not isolated, contained by a job object, 2 tasks at once",
    ["connected", "personal", "not isolated", "contained by a job object", "2 tasks at once"].every((word) => line.toLowerCase().includes(word)),
    line.slice(0, 220),
  );
  await d.shot(d.sam, "08-your-machine");

  // The organization's provider is refused on Sam's machine until Demo allows it there.
  const provider = await d.db.modelProvider.findFirstOrThrow({ where: { organizationId: d.organizationId }, select: { id: true } });
  await d.api.mutate("providers.update", { providerId: provider.id, allowOnPersonalRunners: false });
  const refused = await promptTask(d, { projectId: d.test2.id, title: "Refused on a laptop", steps: 1, ms: 500, as: "sam", runnerId: row.id }).then(
    () => "started",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  d.check(8, "an organization provider is refused on Sam's machine until it's allowed there", refused.includes('personal'), refused.slice(0, 200));
  await d.api.mutate("providers.update", { providerId: provider.id, allowOnPersonalRunners: true });

  await d.sam.goto("/tasks/new");
  await d.sam.getByTestId("pick-project").click();
  await d.sam.getByLabel("Find a project…").fill("test2");
  await d.sam.getByLabel("Find a project…").press("Enter");
  await d.sam.getByTestId("run-on").click();
  const menu = d.sam.getByRole("menu");
  const pool = (await menu.locator('[data-runner="pools"]').innerText()).replaceAll(/\s+/g, " ");
  const machine = (await menu.locator(`[data-runner="sam-laptop"]`).innerText().catch(() => "")).replaceAll(/\s+/g, " ");
  d.check(8, "Sam's New task offers Your machine beside A pool", pool.includes("A pool") && machine.includes("Your machine"), `${pool} | ${machine}`);
  await d.shot(d.sam, "08-new-task-picker");
  await d.sam.keyboard.press("Escape");
  const samTasks: TaskId[] = [];
  for (let index = 1; index <= 3; index += 1) samTasks.push(await promptTask(d, { projectId: d.test2.id, title: `Sam's laptop ${String(index)}`, steps: 10, ms: 4000, as: "sam", runnerId: row.id }));
  await sleep(10_000);
  const onLaptop = await Promise.all(samTasks.map((taskId) => activeLease(d, taskId)));
  d.check(8, "two of Sam's tasks run on Sam's machine, the third waits", onLaptop.filter((lease) => lease?.runnerId === row.id).length === 2 && onLaptop[2] === null, `${String(onLaptop.filter((lease) => lease !== null).length)} running`);
  await d.sam.goto(`/tasks/${samTasks[2] ?? ""}`);
  const busy = d.sam.getByText(/busy \(2 of 2\)/).first();
  await busy.waitFor({ timeout: 30_000 });
  d.check(8, "the third says Your machine is busy (2 of 2)", true, (await busy.innerText()).trim());
  await d.shot(d.sam, "08-laptop-busy");
  const sam = await d.db.member.findFirstOrThrow({ where: { organizationId: d.organizationId, role: "member" }, select: { id: true } });
  const others = await d.db.lease.count({ where: { runnerId: row.id, task: { creatorMemberId: { not: sam.id } } } });
  d.check(8, "Demo's tasks never go to Sam's runner", others === 0, `${String(others)} leases of other members' tasks`);
  say("step 8: done");
};
