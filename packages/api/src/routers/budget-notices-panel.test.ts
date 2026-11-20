import { budgetMonthOf, checkBudgetNotice } from "@ostra/domain";
import { budgetIdSchema } from "@ostra/protocol";
import type { ModelId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedModelRow, seedProviderRow, seedSpendRows } from "../testing/m4-seed.ts";

// F-037 (ticket 36): the budget notices `budget.check` writes reach the panel. A notice has no
// needs-you item, so `notifications.list` leaves it out; `notifications.budgetNotices` lists the
// member's own this month, with its budget and where the spend stands now.

let harness: ApiHarness;
let model: ModelId;
const MONTH = budgetMonthOf(Date.now());

beforeAll(async () => {
  harness = await createApiHarness();
  const { a } = harness.fixture;
  const provider = await seedProviderRow(harness.test.db, a.organization.id, "Notice keys");
  model = await seedModelRow(harness.test.db, { organizationId: a.organization.id, providerId: provider, endpointModelId: "notice-model", inputPricePerMTok: 3, outputPricePerMTok: 15 });
  await seedSpendRows(harness.test.db, a.organization.id, [{ projectId: a.openProject.id, modelId: model, day: `${MONTH}-01`, inputTokens: 1000, spentMicroUsd: 9_100_000 }]);
});

afterAll(async () => {
  await harness.dispose();
});

const check = (budgetId: string, threshold: "warn" | "reached") =>
  checkBudgetNotice(
    { db: harness.test.db, jobs: harness.deps.ports.jobs, notices: harness.deps.ports.notices, clock: harness.deps.ports.clock },
    { organizationId: harness.fixture.a.organization.id, budgetId: budgetIdSchema.parse(budgetId), month: MONTH, threshold },
  );

describe("budget notices in the panel (F-037)", () => {
  it("F-037: a project budget's warning reaches the organization's admins in the panel, naming the project and its share, and not a member", async () => {
    const { a } = harness.fixture;
    const admin = await harness.as(a.admin);
    // $9.10 spent against $10.00: 91%, past the warn line.
    const { budgetId } = await admin.budgets.set({ projectId: a.openProject.id, monthlyUsd: 10 });
    await harness.test.db.budgetNotice.deleteMany({});
    await harness.test.db.notification.deleteMany({ where: { kind: { in: ["budget_warning", "budget_reached"] } } });
    expect(await check(budgetId, "warn")).toMatchObject({ kind: "sent" });

    const project = await harness.test.db.project.findUniqueOrThrow({ where: { id: a.openProject.id }, select: { name: true } });
    const notices = await admin.notifications.budgetNotices();
    expect(notices).toEqual([
      expect.objectContaining({ threshold: "warn", read: false, scope: { kind: "project", projectId: a.openProject.id, name: project.name }, percent: 91 }),
    ]);
    // Not a needs-you row: the list of items stays as it was.
    expect((await admin.notifications.list({ tab: "open" })).rows.every((row) => row.kind !== "budget_warning")).toBe(true);
    // A member who isn't an admin gets no notice.
    expect(await (await harness.as(a.member)).notifications.budgetNotices()).toEqual([]);

    // Lowering the budget below the spend: the reached notice joins it, newest first.
    await admin.budgets.set({ projectId: a.openProject.id, monthlyUsd: 5 });
    expect(await check(budgetId, "reached")).toMatchObject({ kind: "sent" });
    const after = await admin.notifications.budgetNotices();
    expect(after.map((notice) => notice.threshold)).toEqual(["reached", "warn"]);
    expect(after[0]?.percent).toBe(182);

    // Read in the panel: it stays this month's, marked read.
    await admin.notifications.markRead({ ids: [after[0]?.notificationId].flatMap((id) => (id === undefined ? [] : [id])) });
    expect((await admin.notifications.budgetNotices())[0]?.read).toBe(true);
  });
});
