import type { Demo } from "./context.ts";

// Spec section 3, step 15, the part this machine can run live: one GitHub organization and the
// test App. Organization, "GitHub" lists the App's installation on the test org as linked, and shows
// either the install link to send ("Add a GitHub organization", a public App) or the line that
// GitHub lets only the App's own account install a private App. The waiting installation, its
// link, the refused `projects.addRepo` and the delivery stored nowhere need a second organization
// (ticket 55): they run on the fake GitHub, in apps/web/e2e/10-github-organizations.spec.ts and
// core's and the API's linked-installations tests.

/** Step 15, live half: the linked installation, and how another organization would join. */
export const githubOrganizations = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  await demo.goto("/organization/github");
  await demo.waitForLoadState("networkidle");
  const ours = demo.locator(`[data-testid="installation"][data-account="${settings.githubOrg}"]`).first();
  await ours.waitFor({ timeout: 30_000 });
  const state = (await ours.getAttribute("data-state")) ?? "";
  d.check("step 15: GitHub lists the App's installation on the test org, linked", state === "linked", `${settings.githubOrg}: ${state}`);
  const addOrg = await demo.getByTestId("add-organization").count();
  const privateApps = await demo.getByTestId("private-apps").innerText().catch(() => "");
  const explained = addOrg > 0 || privateApps.includes("GitHub lets only its owner install a private App");
  d.check("step 15: the page shows the install link to send, or why a private App can't be installed elsewhere", explained, addOrg > 0 ? "the install link (a public App)" : "the private App's line, with the link to its settings");
  await d.shot(demo, "step15-github-organizations");
  d.run.notes["step15"] = "live: the linked installation and the private App's line; the second organization's half ran on the fake GitHub (ticket 55 is the live run)";
};
