import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { notificationIdSchema, projectIdSchema } from "@ostra/protocol";

import { BudgetNoticeRows, budgetNoticeText } from "./budget-notices";
import type { BudgetNotice } from "./budget-notices";

// F-037 (ticket 36): a budget's notices among Home's and Needs you's rows, as `budget.check` sent them.

const projectId = projectIdSchema.parse("01900000-0000-7000-8000-000000000031");
const warn: BudgetNotice = {
  notificationId: notificationIdSchema.parse("01900000-0000-7000-8000-0000000000a1"),
  threshold: "warn",
  read: false,
  createdAt: Date.UTC(2026, 10, 19),
  scope: { kind: "project", projectId, name: "test1" },
  percent: 91,
};
const reached: BudgetNotice = { ...warn, notificationId: notificationIdSchema.parse("01900000-0000-7000-8000-0000000000a2"), threshold: "reached", scope: { kind: "organization" }, percent: 104 };

describe("budget notices (F-037)", () => {
  it("F-037/c3: the warning names the project and its share; the reached notice names the budget", () => {
    expect(budgetNoticeText(warn)).toBe("test1 is at 91% of its budget");
    expect(budgetNoticeText(reached)).toBe("The organization reached its budget");
  });

  it("F-037/c3: an organization admin's row opens Spend with the budget selected; a project admin's opens the project", () => {
    const admin = renderToStaticMarkup(<BudgetNoticeRows notices={[warn, reached]} organizationAdmin />);
    expect(admin).toContain(`href="/organization/spend?project=${projectId}"`);
    expect(admin).toContain('href="/organization/spend?project=organization"');
    expect(admin).toContain('data-threshold="reached"');
    const projectAdmin = renderToStaticMarkup(<BudgetNoticeRows notices={[warn]} organizationAdmin={false} />);
    expect(projectAdmin).toContain(`href="/projects/${projectId}"`);
    expect(projectAdmin).not.toContain("/organization/spend");
    expect(renderToStaticMarkup(<BudgetNoticeRows notices={[]} organizationAdmin />)).toBe("");
  });
});
