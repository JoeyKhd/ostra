import { expect, test } from "@playwright/test";

import { expectNoHorizontalScroll, signIn } from "./helpers.ts";
import { signedInPage, seedM4Member } from "./m4.ts";
import { chooseTheme, seedAgentWorld, shootM6 } from "./m6.ts";

// F-012, F-040 (milestone 6's ticket 33): Connect Linear's agent mode and its boards' "Start from
// Linear", a project's Needs approval with its outside tasks, Home's row, and the task page's banner,
// through the panel, the API, the domain's use cases and the database, with the stack's fake Linear
// as the organization's connection. The token's consent itself happens at linear.app, which the
// stack can't reach: the seed leaves the token as the consent would (agent mode's scopes granted),
// and "Turn on agent mode" turns it on through `linear.enableAgentMode`.

test("F-012/c1, F-040/c1: an admin turns on agent mode, switches a board on, and approves one outside task and rejects another", { tag: "@desktop-only" }, async ({ page }) => {
  const world = await seedAgentWorld();
  await signIn(page);

  // Agent mode: off, its scopes granted, and the one press that turns it on.
  await page.goto("/organization/linear");
  const state = page.getByTestId("agent-mode-state");
  await expect(state).toContainText("Off");
  await expect(page.getByTestId("agent-mode-scopes")).toContainText("app:assignable");
  await expect(page.getByTestId("agent-mode-scopes")).toContainText("app:mentionable");
  await page.getByTestId("turn-on-agent-mode").click();
  await expect(state).toContainText("On");
  await expect(state).toContainText("turned on");

  // Start from Linear on the project's board: the switch saves at once and says so.
  const boardRow = page.getByTestId("agent-boards").locator(`[data-board="${world.boardName}"]`);
  await boardRow.getByRole("switch", { name: `Start from Linear on ${world.boardName}` }).click();
  await expect(page.getByTestId("agent-board-line")).toHaveText(`${world.boardName} takes AGT's delegations now.`);
  await expect(boardRow.getByRole("switch")).toBeChecked();
  await expect(page.getByTestId("agent-events")).toContainText("Casey Moore");
  await expect(page.getByTestId("agent-events")).toContainText("Waiting for approval");
  await shootM6(page, "linear-agent-mode");
  // The project's Boards page shows the same switch, on.
  await page.goto(`/projects/${world.projectId}/boards`);
  await expect(page.getByRole("switch", { name: `Start from Linear on ${world.boardName}` })).toBeChecked();

  // Home: each outside task is a needs-you row whose "Approve" opens the project's Needs approval.
  const [first, second, third] = world.tasks;
  if (first === undefined || second === undefined || third === undefined) throw new Error("the seed made three outside tasks");
  await page.goto("/");
  const homeRow = page.getByTestId("needs-you").locator("li").filter({ hasText: first.key });
  await expect(homeRow).toBeVisible();
  await homeRow.getByRole("link", { name: "Approve" }).click();
  await page.waitForURL(`**/projects/${world.projectId}/needs-approval?task=${first.id}`);

  // Needs approval: oldest first, the asked-for one open, who started it and what would run.
  await expect(page.getByRole("heading", { level: 1, name: "Needs approval" })).toBeVisible();
  await expect(page.getByTestId("approvals-count")).toHaveText("3");
  await expect(page.getByTestId("needs-approval-count")).toHaveText("3");
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(3);
  expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-key")))).toEqual([first.key, second.key, third.key]);
  const block = rows.filter({ hasText: first.key }).getByTestId("approval-block");
  await expect(block).toContainText(`Casey Moore delegated ${first.key} to ostra in Linear.`);
  await expect(block).toContainText("e2e-agent-pool");
  await expect(block).toContainText("never a personal runner");
  await shootM6(page, "needs-approval");

  // Approve the first: it's queued, on the pool.
  await block.getByRole("button", { name: "Approve" }).click();
  await expect(rows.filter({ hasText: first.key }).getByTestId("approval-answered")).toHaveText("Approved by you. It's queued on e2e-agent-pool.");

  // A collapsed row answers in place: its Reject and Approve, no chevron.
  await expect(rows.filter({ hasText: third.key }).getByRole("button", { name: `Approve ${third.key}` })).toBeVisible();
  // Reject the second from its row, with a reason for the person in Linear.
  const secondRow = rows.filter({ hasText: second.key });
  await secondRow.getByRole("button", { name: `Reject ${second.key}` }).click();
  await secondRow.getByRole("textbox", { name: "Why, for the person in Linear (optional)" }).fill("Billing doesn't take outside work this week.");
  await secondRow.getByTestId("approval-block").getByRole("button", { name: "Reject" }).click();
  await expect(secondRow.getByTestId("approval-answered")).toHaveText("Rejected by you.");

  // Both answers stand: a reload lists only the third, and the tasks moved on.
  await page.reload();
  await expect(page.getByTestId("approval-row")).toHaveCount(1);
  await expect(page.getByTestId("needs-approval-count")).toHaveText("1");
  await page.goto(`/tasks/${first.id}`);
  await expect(page.getByTestId("task-doing")).not.toHaveAttribute("data-state", "awaiting_approval");
  await page.goto(`/tasks/${second.id}`);
  await expect(page.getByTestId("task-doing")).toHaveAttribute("data-state", "stopped");

  // The third's task page: "Started in Linear by", and the same block as a banner.
  await page.goto(`/tasks/${third.id}`);
  await expect(page.getByTestId("started-in-linear")).toHaveText("Started in Linear by Casey Moore");
  await expect(page.getByTestId("awaiting-banner").getByRole("button", { name: "Approve" })).toBeVisible();
  await shootM6(page, "task-awaiting-approval");
});

test("F-040: only an organization admin switches outside approval; a member reads it and can still approve", { tag: "@desktop-only" }, async ({ page, browser }) => {
  const world = await seedAgentWorld();
  await seedM4Member("e2e-agent-member");
  const member = await signedInPage(browser, "e2e-agent-member");
  await member.goto(`/projects/${world.projectId}/needs-approval`);
  const memberSwitch = member.getByRole("switch", { name: "Outside tasks need approval in e2e-agent" });
  await expect(memberSwitch).toBeChecked();
  await expect(memberSwitch).toBeDisabled();
  await expect(member.getByText("Only an organization admin changes this.")).toBeVisible();
  await member.context().close();

  // The admin turns it off, after a confirmation, and back on.
  await signIn(page);
  await page.goto(`/projects/${world.projectId}/needs-approval`);
  const adminSwitch = page.getByRole("switch", { name: "Outside tasks need approval in e2e-agent" });
  await adminSwitch.click();
  await page.getByRole("button", { name: "Turn off approval" }).click();
  await expect(adminSwitch).not.toBeChecked();
  await expect(page.getByTestId("approval-off")).toContainText("Outside tasks start at once in e2e-agent");
  await page.reload();
  await expect(page.getByRole("switch", { name: "Outside tasks need approval in e2e-agent" })).not.toBeChecked();
  await page.getByRole("switch", { name: "Outside tasks need approval in e2e-agent" }).click();
  await expect(page.getByRole("switch", { name: "Outside tasks need approval in e2e-agent" })).toBeChecked();
});

test("ticket 33: the agent mode and approval screens in light, for the by-eye check", { tag: "@desktop-only" }, async ({ page }) => {
  test.skip(process.env["OSTRA_E2E_SHOTS"] === undefined, "screenshots only");
  const world = await seedAgentWorld();
  await signIn(page);
  await chooseTheme(page, "Light");
  await page.goto("/organization/linear");
  await expect(page.getByTestId("agent-mode-state")).toBeVisible();
  await shootM6(page, "light-linear-agent-mode");
  await page.goto(`/projects/${world.projectId}/needs-approval`);
  await expect(page.getByRole("heading", { level: 1, name: "Needs approval" })).toBeVisible();
  await shootM6(page, "light-needs-approval");
  await chooseTheme(page, "Dark");
});

// At phone width (F-075), in the desktop project too.
test.describe("at phone width", () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });

  test("F-012, F-040: agent mode and Needs approval fit a phone", async ({ page }) => {
    const world = await seedAgentWorld();
    await signIn(page);
    await page.goto("/organization/linear");
    await expect(page.getByTestId("agent-mode-state")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "linear-agent-mode");
    await page.goto(`/projects/${world.projectId}/needs-approval`);
    await expect(page.getByRole("heading", { level: 1, name: "Needs approval" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shootM6(page, "needs-approval");
  });
});
