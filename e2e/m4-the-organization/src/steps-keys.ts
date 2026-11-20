import { say } from "@ostra/e2e-m1/setup";
import type { Page } from "@playwright/test";
import { z } from "zod";

import type { Demo } from "./context.ts";
import { spendMonth } from "./steps-money.ts";
import { createRepoProject, projectIdOf } from "./steps-setup.ts";
import { sleep, waitFor } from "./state.ts";
import { auditSince, sendMessage, settled, startPromptTask, taskRow } from "./tasks.ts";

// Spec section 3, steps 16 and 17: two clients, two keys, and no key with no fallback. Without
// ticket 55's `model-b.env` there's one model key: `client-b` is a second provider on the same
// endpoint and key, so the routing per project is real and the token's separation is the fakes'
// (ticket 48's tests). Without a second GitHub organization, `portal` has `test2` only.

export const CLIENT_B = "client-b";
export const BUILDER = "Builder";

const planSchema = z.looseObject({
  version: z.string(),
  lines: z.array(z.looseObject({ text: z.string(), change: z.string() })),
  whatHappens: z.looseObject({ released: z.looseObject({ count: z.number() }), waiting: z.looseObject({ count: z.number() }) }),
});
type Plan = z.infer<typeof planSchema>;

/** A project's providers: its own list of the named providers, previewed then saved. */
const setList = async (d: Demo, page: Page, projectId: string, providerIds: readonly string[]): Promise<{ readonly preview: Plan | null; readonly saved: boolean; readonly code: string }> => {
  const mode = { kind: "own", providerIds };
  const preview = await d.query(page, "projects.previewProviders", { projectId, mode });
  if (!preview.ok) return { preview: null, saved: false, code: preview.code };
  const plan = planSchema.parse(preview.data);
  const saved = await d.mutate(page, "projects.setProviders", { projectId, mode, version: plan.version });
  return { preview: plan, saved: saved.ok, code: saved.ok ? "ok" : saved.code };
};

const providerOfLastSession = async (d: Demo, taskId: string): Promise<string | null> => {
  const session = await d.db.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" }, select: { provider: { select: { name: true } } } });
  return session?.provider?.name ?? null;
};

/** The task page's "Key · …" line. */
const keyLine = async (page: Page, taskId: string): Promise<string> => {
  await page.goto(`/tasks/${taskId}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  return /Key\s*·\s*[\w-]+/.exec(await page.locator("main").innerText())?.[0] ?? "";
};

/** `client-b`: a second provider row, on no list (one model key on this machine). */
const addClientB = async (d: Demo): Promise<string> => {
  const known = await d.db.modelProvider.findFirst({ where: { name: CLIENT_B }, select: { id: true } });
  if (known !== null) return known.id;
  const a = await d.db.modelProvider.findFirstOrThrow({ where: { name: "client-a" }, select: { apiFormat: true, authScheme: true } });
  const made = await d.mutate(d.demo, "providers.create", {
    name: CLIENT_B,
    baseUrl: d.settings.modelBaseUrl,
    // The database spells the format with an underscore; the API with a hyphen.
    apiFormat: a.apiFormat.replaceAll("_", "-"),
    authScheme: a.authScheme.replaceAll("_", "-"),
    sessionsAtOnce: null,
    allowOnPersonalRunners: true,
    token: d.settings.modelApiKey,
  });
  if (!made.ok) throw new Error(`adding client-b: ${made.code} ${made.message.slice(0, 160)}`);
  const row = await d.db.modelProvider.findFirstOrThrow({ where: { name: CLIENT_B }, select: { id: true } });
  return row.id;
};

/** The `Builder` profile: the dev model by its name. */
const builder = async (d: Demo): Promise<string> => {
  const { demo, settings } = d;
  const known = await d.db.agentProfile.findFirst({ where: { name: BUILDER, archivedAt: null }, select: { id: true } });
  if (known !== null) return known.id;
  await demo.goto("/organization/agent-profiles");
  await demo.getByRole("link", { name: "New profile" }).first().click();
  await demo.getByTestId("profile-eyebrow").waitFor();
  await demo.getByTestId("profile-name").fill(BUILDER);
  const model = await d.db.model.findFirst({ where: { endpointModelId: settings.modelId }, select: { displayName: true } });
  await demo.getByTestId("profile-model").click();
  await demo.getByRole("option", { name: new RegExp(model?.displayName ?? settings.modelId) }).first().click();
  await demo.getByRole("textbox", { name: "Instructions" }).fill("Make the change the task asks for, and keep it small.");
  await d.shot(demo, "step16-builder-profile");
  await demo.locator('[data-action="save-profile"]').click();
  await demo.getByRole("status").filter({ hasText: "Saved." }).first().waitFor({ timeout: 30_000 });
  const row = await d.db.agentProfile.findFirstOrThrow({ where: { name: BUILDER }, select: { id: true } });
  return row.id;
};

/** Step 16: client-a and client-b, calculator and portal, a task in each on its own key. */
export const twoKeys = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const clientA = d.id("provider:client-a");
  await demo.goto("/organization/models");
  await demo.waitForLoadState("networkidle");
  const onDefault = await d.db.providerListEntry.count({ where: { projectId: null, providerId: clientA } });
  d.check("step 16: Models lists client-a on the default list", onDefault === 1, `${String(onDefault)} default-list entry`);
  await d.shot(demo, "step16-models-default-list");
  const clientB = await addClientB(d);
  d.run.ids["provider:client-b"] = clientB;
  const bLists = await d.db.providerListEntry.count({ where: { providerId: clientB } });
  d.check("step 16: client-b is on no list, so no project can use it", bLists === 0, `${String(bLists)} list entries`);
  await demo.goto("/organization/models");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step16-models-client-b");
  if (d.run.ids["project:calculator"] === undefined) {
    d.run.ids["project:calculator"] = projectIdOf(await createRepoProject(d, "calculator", settings.githubRepo));
    await d.save();
  }
  if (d.run.ids["project:portal"] === undefined) {
    d.run.ids["project:portal"] = projectIdOf(await createRepoProject(d, "portal", settings.githubOtherRepo));
    await d.save();
  }
  const calculator = d.id("project:calculator");
  const portal = d.id("project:portal");
  const a = await setList(d, demo, calculator, [clientA]);
  const b = await setList(d, demo, portal, [clientB]);
  d.check("step 16: calculator's own list is client-a, portal's is client-b", a.saved && b.saved, `${a.code}, ${b.code}`);
  const profile = await builder(d);
  for (const projectId of [calculator, portal]) {
    const set = await d.mutate(demo, "projects.setDefaultProfile", { projectId, kind: "code", profileId: profile });
    if (!set.ok) say(`step 16: setting ${BUILDER} as ${projectId}'s default: ${set.code}`);
  }
  await demo.goto(`/projects/${portal}/settings/models`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step16-portal-models");
  if (d.run.ids["task:step16-calculator"] === undefined) {
    d.run.ids["task:step16-calculator"] = await startPromptTask(demo, calculator, "Add `docs/client.md` saying this app belongs to client A", settings.runnerName);
    await d.save();
  }
  if (d.run.ids["task:step16-portal"] === undefined) {
    d.run.ids["task:step16-portal"] = await startPromptTask(demo, portal, "In test2, add a line to `CHANGELOG.md` naming the portal for client B.", settings.runnerName);
    await d.save();
  }
  const calcTask = d.id("task:step16-calculator");
  const portalTask = d.id("task:step16-portal");
  await settled(d, calcTask);
  await settled(d, portalTask);
  const calcKey = await keyLine(demo, calcTask);
  await d.shot(demo, "step16-calculator-task");
  const portalKey = await keyLine(demo, portalTask);
  await d.shot(demo, "step16-portal-task");
  d.check("step 16: the task pages show Key · client-a and Key · client-b", calcKey.includes("client-a") && portalKey.includes(CLIENT_B), `${calcKey} | ${portalKey}`);
  const calcProvider = await providerOfLastSession(d, calcTask);
  const portalProvider = await providerOfLastSession(d, portalTask);
  d.check("step 16: each session ran on its project's key", calcProvider === "client-a" && portalProvider === CLIENT_B, `${calcProvider ?? "none"}, ${portalProvider ?? "none"}`);
  const portalPrs = await d.db.taskPullRequest.findMany({ where: { taskRepo: { taskId: portalTask } }, select: { url: true } });
  d.run.notes["step16-portal-prs"] = portalPrs.map((pr) => pr.url).join(", ");
  // Spend by key.
  const { view } = await spendMonth(d);
  const byKey = Object.fromEntries(view.byProvider.map((line) => [line.name, line.spentMicroUsd]));
  const sessions = await d.db.session.findMany({ where: { taskId: { in: [calcTask, portalTask] } }, select: { taskId: true, providerId: true } });
  const separate = sessions.every((session) => (session.taskId === calcTask ? session.providerId === clientA : session.providerId === clientB));
  d.check("step 16: Spend by key: client-a's month holds calculator's task, client-b's holds portal's alone", separate && (byKey[CLIENT_B] ?? 0) > 0, `by key ${JSON.stringify(byKey)}`);
  await demo.goto("/organization/spend");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step16-spend-by-key");
  // client-b on calculator's list too: nothing moves, and the model stays on client-a.
  const both = await setList(d, demo, calculator, [clientA, clientB]);
  const moves = both.preview?.lines.filter((line) => line.change === "moves").length ?? -1;
  d.check("step 16: adding client-b to calculator's list: the preview says nothing moves", both.saved && moves === 0, `${String(moves)} lines move`);
  const again = await startPromptTask(demo, calculator, "Add one line to `docs/client.md`: the contact is in the CRM", settings.runnerName);
  d.run.ids["task:step16-calculator-2"] = again;
  await d.save();
  await settled(d, again);
  const againKey = await keyLine(demo, again);
  d.check("step 16: a new task there shows Key · client-a", againKey.includes("client-a") && (await providerOfLastSession(d, again)) === "client-a", againKey);
  await d.shot(demo, "step16-calculator-still-a");
  const off = await setList(d, demo, calculator, [clientA]);
  d.check("step 16: Demo takes client-b off again", off.saved, off.code);
  // Sam: calculator's Models and keys, read-only; setProviders refused.
  const sam = await d.page("sam");
  await sam.goto(`/projects/${calculator}/settings/models`);
  await sam.waitForLoadState("networkidle");
  const samText = await sam.locator("main").innerText();
  const samButtons = await sam.locator("main").getByRole("button", { name: /Save|Edit|Add/ }).count();
  d.check("step 16: Sam sees calculator's providers by name, no token and no edit", samText.includes("client-a") && !samText.includes(settings.modelApiKey) && samButtons === 0, `${String(samButtons)} edit buttons`);
  await d.shot(sam, "step16-sam-models-and-keys");
  for (const [name, projectId] of [["calculator", calculator], ["test2", d.id("project:test2")]] as const) {
    const refused = await d.mutate(sam, "projects.setProviders", { projectId, mode: { kind: "default" }, version: "x" });
    d.check(`step 16: projects.setProviders as Sam on ${name} is FORBIDDEN`, !refused.ok && refused.code === "FORBIDDEN", refused.ok ? "saved" : refused.code);
  }
};

/** Step 17: client-a off calculator's list: no key, a held message, refused starts; then back. */
export const noKey = async (d: Demo): Promise<void> => {
  const { demo } = d;
  const calculator = d.id("project:calculator");
  const clientA = d.id("provider:client-a");
  const taskId = d.id("task:step16-calculator");
  const since = Date.now();
  await settled(d, taskId);
  const off = await setList(d, demo, calculator, []);
  d.check("step 17: the preview says the model has no key in calculator", (off.preview?.whatHappens.waiting.count ?? 0) > 0 || (off.preview?.lines.some((line) => line.change === "loses") ?? false), JSON.stringify(off.preview?.whatHappens ?? {}));
  d.check("step 17: the save goes through", off.saved, off.code);
  d.run.notes["step17-released"] = String(off.preview?.whatHappens.released.count ?? 0);
  await sendMessage(demo, taskId, "Also name client A's contact");
  await sleep(4000);
  await demo.reload();
  await demo.waitForLoadState("networkidle");
  const thread = await demo.locator("main").innerText();
  const noKeyLine = /No key for [^\n]* in calculator[^\n]*/.exec(thread)?.[0] ?? "";
  d.check("step 17: the message is held, and the thread says there's no key", noKeyLine !== "", noKeyLine || "no such line");
  await d.shot(demo, "step17-held-no-key");
  await demo.goto("/");
  await demo.waitForLoadState("networkidle");
  const home = await demo.locator("main").innerText();
  await d.shot(demo, "step17-demo-home");
  const sam = await d.page("sam");
  await sam.goto("/");
  await sam.waitForLoadState("networkidle");
  const samHome = await sam.locator("main").innerText();
  d.check("step 17: Home's needs-you shows it to Demo and not to Sam", /no key/i.test(home) && !/no key/i.test(samHome), `Demo ${/no key/i.test(home) ? "sees it" : "doesn't"}, Sam ${/no key/i.test(samHome) ? "sees it" : "doesn't"}`);
  const check = await d.query(demo, "tasks.startCheck", { projectId: calculator });
  d.check("step 17: a new task in calculator shows no key before Start", check.ok && /key/i.test(JSON.stringify(check.data)), check.ok ? JSON.stringify(check.data).slice(0, 160) : check.code);
  await demo.goto(`/projects/${calculator}`);
  await demo.getByTestId("new-task").locator("textarea").fill("Add a line to docs/client.md");
  await demo.waitForTimeout(1500);
  await d.shot(demo, "step17-new-task-no-key");
  // client-a back: the held message starts its turn in a fresh box, on client-a.
  const turnsBefore = await d.db.turn.count({ where: { taskId } });
  const back = await setList(d, demo, calculator, [clientA]);
  d.check("step 17: Demo puts client-a back", back.saved, back.code);
  const resumed = await waitFor("the held message's turn", 8 * 60_000, async () => ((await d.db.turn.count({ where: { taskId } })) > turnsBefore ? true : null), 3000).then(() => true, () => false);
  d.check("step 17: the held message starts its turn", resumed, `${String(await d.db.turn.count({ where: { taskId } }))} turns`);
  await settled(d, taskId).catch(() => undefined);
  d.check("step 17: on client-a", (await providerOfLastSession(d, taskId)) === "client-a", (await providerOfLastSession(d, taskId)) ?? "none");
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step17-resumed");
  const actions = (await auditSince(d, since)).map((entry) => entry.action);
  d.check("step 17: the audit log has each change to the lists", actions.filter((action) => action === "project.providers-changed").length >= 2, actions.filter((action) => action.startsWith("project.")).join(", "));
  d.run.notes["step17-state"] = (await taskRow(d, taskId)).state;
};
