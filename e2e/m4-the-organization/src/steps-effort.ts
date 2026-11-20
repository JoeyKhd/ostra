import { z } from "zod";

import type { Demo } from "./context.ts";
import { BUILDER } from "./steps-keys.ts";
import { waitFor } from "./state.ts";
import { attributes, auditSince, running, sendMessage, settled, startNewTask, turnRunning } from "./tasks.ts";

// Spec section 3, step 18 (F-137, ADR 0066): reasoning effort on `calculator`, after step 17, with
// `client-a` back on its list. `client-a` is `model.env`'s endpoint here, not a stub: the effect
// shows in each turn's level (`turn.started`) and its reasoning tokens (`usage.recorded`), since no
// log holds a request's body.

const turnStartedSchema = z.looseObject({ effort: z.string().optional() });

/** Each turn's level, oldest first, from its `turn.started` event. */
const turnLevels = async (d: Demo, taskId: string): Promise<readonly string[]> =>
  (await d.db.event.findMany({ where: { taskId, kind: "turn.started" }, orderBy: { seq: "asc" }, select: { payload: true } })).map((one) => turnStartedSchema.parse(one.payload).effort ?? "none");

/** The reasoning tokens the task's turns recorded, summed. */
const reasoningTokens = async (d: Demo, taskId: string): Promise<number> =>
  (await d.db.event.findMany({ where: { taskId, kind: "usage.recorded" }, select: { payload: true } })).reduce((sum, one) => sum + (z.looseObject({ reasoningTokens: z.number().optional() }).parse(one.payload).reasoningTokens ?? 0), 0);

export const effort = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const since = Date.now();
  const profile = await d.db.agentProfile.findFirstOrThrow({ where: { name: BUILDER, archivedAt: null }, select: { id: true } });
  // 1. The profile's level: exactly the model's levels, Default first; High saved.
  await demo.goto(`/organization/agent-profiles/${profile.id}`);
  const field = demo.getByTestId("profile-effort");
  await field.waitFor({ timeout: 30_000 });
  const offered = await attributes(field.locator("[data-level]"), "data-level");
  d.check("step 18: the profile's Effort offers the model's levels, Default first", offered[0] === "default" && offered.includes("high") && offered.includes("low"), offered.join(", "));
  await field.locator('[data-level="high"]').click();
  await d.shot(demo, "step18-demo-1-profile-effort");
  await demo.locator('[data-action="save-profile"]').click();
  await demo.getByRole("status").filter({ hasText: "Saved." }).first().waitFor({ timeout: 30_000 });
  const saved = await d.db.agentProfile.findUniqueOrThrow({ where: { id: profile.id }, select: { effort: true } });
  const savedAudit = (await auditSince(d, since)).some((entry) => entry.action === "agent-profile.updated");
  d.check("step 18: High saves, with an audit entry", saved.effort === "high" && savedAudit, `${saved.effort}, audit ${savedAudit ? "written" : "missing"}`);
  // 3. Models: the model's reasoning, from the catalog.
  await demo.goto("/organization/models");
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step18-demo-3-models-reasoning");
  // 4. A task at High.
  const calculator = d.id("project:calculator");
  if (d.run.ids["task:step18"] === undefined) {
    d.run.ids["task:step18"] = await startNewTask(demo, "calculator", "Add `docs/effort.md` with one line. Before you finish, run `node -e \"setTimeout(() => {}, 60000)\"` once, so the turn takes a minute.", settings.runnerName, BUILDER);
    await d.save();
  }
  const taskId = d.id("task:step18");
  await running(d, taskId);
  await demo.goto(`/tasks/${taskId}`);
  await demo.getByTestId("task-effort").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const shown = await demo.getByTestId("task-effort").first().getAttribute("data-level").catch(() => null);
  d.check("step 18: the task page shows Effort · High", shown === "high", shown ?? "no Effort row");
  await d.shot(demo, "step18-demo-4-task-high");
  // 5. While the turn runs, the driver picks Low: from the next turn.
  const duringTurn = await turnRunning(d, taskId);
  const changed = await d.mutate(demo, "tasks.setEffort", { taskId, level: "low" });
  d.check("step 18: Demo, the driver, picks Low while the turn runs", changed.ok && duringTurn, `${changed.ok ? "changed" : changed.code}${duringTurn ? ", during the turn" : ", after the turn ended"}`);
  await demo.reload();
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step18-demo-5-changed-to-low");
  await settled(d, taskId);
  const first = await turnLevels(d, taskId);
  d.check("step 18: the running turn finishes at High", first[0] === "high", first.join(", "));
  // 6. The next turn runs at Low.
  await sendMessage(demo, taskId, "Also add a second line");
  await waitFor("the second turn", 8 * 60_000, async () => ((await turnLevels(d, taskId)).length >= 2 ? true : null), 3000);
  await settled(d, taskId);
  const levels = await turnLevels(d, taskId);
  const tokens = await reasoningTokens(d, taskId);
  d.check("step 18: the next turn runs at Low", levels[1] === "low", `${levels.join(", ")}; ${String(tokens)} reasoning tokens in all`);
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step18-demo-6-second-turn-low");
  // 7. Sam isn't the driver: sees the level, can't change it.
  const sam = await d.page("sam");
  await sam.goto(`/tasks/${taskId}`);
  await sam.waitForLoadState("networkidle");
  const samLevel = await sam.getByTestId("task-effort").first().getAttribute("data-level").catch(() => null);
  const samTrigger = await sam.getByTestId("task-effort-trigger").count();
  d.check("step 18: Sam sees Effort · Low with no control", samLevel === "low" && samTrigger === 0, `${samLevel ?? "no Effort row"}, ${String(samTrigger)} controls`);
  await d.shot(sam, "step18-demo-7-sam-no-control");
  const refused = await d.mutate(sam, "tasks.setEffort", { taskId, level: "high" });
  d.check("step 18: tasks.setEffort as Sam is FORBIDDEN", !refused.ok && refused.code === "FORBIDDEN", refused.ok ? "changed" : refused.code);
  d.run.notes["step18-demo-project"] = calculator;
};
