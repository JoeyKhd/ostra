import { readdir } from "node:fs/promises";
import path from "node:path";

import { say } from "@ostra/e2e-m1/setup";
import { readIssue } from "@ostra/e2e-m2/linear";

import type { Demo } from "./context.ts";
import { waitFor } from "./state.ts";
import { attributes, sendMessage, settled, startFromInbox, ticket } from "./tasks.ts";

// Spec section 3, steps 3 to 5: a second repo in test1, a task across test1 and test2, and the
// independent-review check on both PRs.

export const STEP4_TITLE = "Set the API version in test1, and log it in test2";
export const STEP4_TEXT =
  'In test1, add `"apiVersion": 2` to `config/settings.json`. In test2, add a line to `CHANGELOG.md` saying test1\'s API version is now 2.';

/** Step 3: test1's settings, Repos, Add repo: test2. */
export const secondRepo = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const test1 = d.id("project:test1");
  const other = `${settings.githubOrg}/${settings.githubOtherRepo}`;
  await demo.goto(`/projects/${test1}/settings/repos`);
  const list = demo.getByTestId("project-repos");
  await list.waitFor({ timeout: 30_000 });
  if ((await demo.locator(`li[data-repo="${other}"]`).count()) === 0) {
    await demo.getByTestId("add-repo").click();
    await d.shot(demo, "step03-add-repo");
    await demo.getByRole("option", { name: new RegExp(settings.githubOtherRepo) }).first().click();
    await demo.locator(`li[data-repo="${other}"]`).waitFor({ timeout: 30_000 });
  }
  const order = await attributes(list.locator("li[data-repo]"), "data-repo");
  d.check("step 3: the project lists both repos, in order", order.join(",") === `${settings.githubOrg}/${settings.githubRepo},${other}`, order.join(", "));
  await d.shot(demo, "step03-repos");
  await demo.goto(`/projects/${test1}/environment`);
  await demo.waitForLoadState("networkidle");
  const env = await demo.locator("main").innerText();
  d.check("step 3: the environment shows a section per repo", env.includes(settings.githubRepo) && env.includes(settings.githubOtherRepo), "both repos named on the environment page");
  await d.shot(demo, "step03-environment");
};

const prSchema = (body: string | null | undefined): string => body ?? "";

/** Step 4: the ticket across test1 and test2, started from the Inbox; one branch, two PRs. */
export const acrossRepos = async (d: Demo): Promise<void> => {
  const { demo, settings, github } = d;
  const test1 = d.id("project:test1");
  const made = await ticket(d, "step4", STEP4_TITLE, STEP4_TEXT);
  if (d.run.ids["task:step4"] === undefined) {
    d.run.ids["task:step4"] = await startFromInbox(d, demo, test1, made.identifier, settings.runnerName);
    await d.save();
  }
  const taskId = d.id("task:step4");
  await demo.goto(`/tasks/${taskId}`);
  await d.shot(demo, "step04-started");
  // The workspace holds both repos side by side.
  const workspace = path.join(settings.runnerDataDir, "tasks", taskId, "workspace");
  const none: readonly string[] = [];
  const folders = await waitFor("both checkouts", 10 * 60_000, async (): Promise<readonly string[] | null> => {
    const names = await readdir(workspace).catch(() => none);
    return names.includes(settings.githubRepo) && names.includes(settings.githubOtherRepo) ? names : null;
  }, 3000).catch(() => none);
  d.check("step 4: one session checks both repos out side by side", folders.includes(settings.githubRepo) && folders.includes(settings.githubOtherRepo), `workspace holds ${folders.join(", ")}`);
  const state = await settled(d, taskId);
  say(`step 4: the task is ${state}`);
  const repos = await d.db.taskRepo.findMany({ where: { taskId }, select: { branchName: true, prNumber: true, prUrl: true, repo: { select: { fullName: true } } }, orderBy: { createdAt: "asc" } });
  const branches = new Set(repos.map((repo) => repo.branchName));
  d.check("step 4: one branch name in both repos", repos.length === 2 && branches.size === 1, `${String(repos.length)} repos, branches ${[...branches].join(", ")}`);
  const prs = await waitFor("both PRs", 5 * 60_000, async () => {
    const rows = await d.db.taskPullRequest.findMany({ where: { taskRepo: { taskId } }, select: { number: true, url: true, taskRepo: { select: { repo: { select: { fullName: true } } } } } });
    return rows.length >= 2 ? rows : null;
  }, 5000).catch(() => []);
  d.check("step 4: two PRs open, one per repo", prs.length === 2 && new Set(prs.map((pr) => pr.taskRepo.repo.fullName)).size === 2, prs.map((pr) => pr.url).join(", "));
  for (const pr of prs) {
    const [owner = "", repo = ""] = pr.taskRepo.repo.fullName.split("/");
    d.run.ids[`pr:step4:${repo}`] = String(pr.number);
    const body = prSchema((await github.octokit.rest.pulls.get({ owner, repo, pull_number: pr.number })).data.body);
    const others = prs.filter((one) => one.number !== pr.number || one.taskRepo.repo.fullName !== pr.taskRepo.repo.fullName);
    const related = /Related/i.test(body) && others.every((one) => body.includes(one.url) || body.includes(`${one.taskRepo.repo.fullName}#${String(one.number)}`));
    d.check(`step 4: ${repo}'s PR has a Related section naming the other`, related, `${pr.url}: ${related ? "names the other" : "no Related link found"}`);
  }
  await d.save();
  const issue = await readIssue(d.tool, made.id);
  const linked = prs.every((pr) => issue.attachments.nodes.some((one) => one.url === pr.url));
  d.check("step 4: the ticket links both PRs", linked, `${String(issue.attachments.nodes.length)} attachments`);
  const row = await d.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true } });
  d.check("step 4: the task is in review", row.state === "in_review", row.state);
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step04-task");
  await demo.goto(`/tasks/${taskId}?tab=changes`);
  await demo.waitForLoadState("networkidle");
  await demo.waitForTimeout(2000);
  const changes = await demo.locator("main").innerText();
  d.check("step 4: the Changes tab shows each repo on its own", changes.includes(settings.githubRepo) && changes.includes(settings.githubOtherRepo), "both repos on the Changes tab");
  await d.shot(demo, "step04-changes");
  await demo.goto(`/tasks/${taskId}?tab=checks`);
  await demo.waitForLoadState("networkidle");
  await demo.waitForTimeout(2000);
  await d.shot(demo, "step04-checks");
};

const REVIEW_CHECK = "ostra/independent-review";

/** The independent-review check run on a PR's head, as GitHub has it. */
const checkOnHead = async (d: Demo, repo: string, prNumber: number) => {
  const { github } = d;
  const pull = await github.octokit.rest.pulls.get({ owner: github.owner, repo, pull_number: prNumber });
  const runs = await github.octokit.rest.checks.listForRef({ owner: github.owner, repo, ref: pull.data.head.sha, check_name: REVIEW_CHECK });
  const run = runs.data.check_runs[0];
  return { sha: pull.data.head.sha, status: run?.status ?? null, conclusion: run?.conclusion ?? null, title: run?.output.title ?? null };
};

/** Step 5: the check on both PRs; the reviewer's half needs ticket 42's tokens. */
export const reviewCheck = async (d: Demo): Promise<void> => {
  const { demo, settings, github } = d;
  const taskId = d.id("task:step4");
  const repos = [settings.githubRepo, settings.githubOtherRepo];
  for (const repo of repos) {
    const number = Number(d.id(`pr:step4:${repo}`));
    const check = await waitFor(`${REVIEW_CHECK} on ${repo}#${String(number)}`, 5 * 60_000, async () => {
      const found = await checkOnHead(d, repo, number);
      return found.status === null ? null : found;
    }, 5000).catch(() => null);
    d.check(`step 5: ${repo}'s PR shows ${REVIEW_CHECK} waiting`, check !== null && check.status !== "completed", check === null ? "no check run" : `${check.status ?? ""} ${check.conclusion ?? ""}: ${check.title ?? ""}`);
    if (check !== null) d.run.notes[`step5-check-${repo}`] = `${check.status ?? ""}/${check.conclusion ?? "none"}: ${check.title ?? ""}`;
  }
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  const states = await demo.getByTestId("review-check").allInnerTexts();
  d.check("step 5: the task page shows the check waiting on both PRs", states.length === 2 && states.every((text) => /Waiting/i.test(text)), states.join(" | "));
  await d.shot(demo, "step05-check-waiting");
  // Branch protection needs the test token (ticket 42): tried with the App's token, recorded either way.
  if (settings.testToken === null) {
    const tried = await github.octokit.rest.repos
      .updateBranchProtection({ owner: github.owner, repo: settings.githubRepo, branch: "main", required_status_checks: { strict: false, contexts: [REVIEW_CHECK] }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null })
      .then(() => "set with the App's token", (error: unknown) => `refused to the App's token (${error instanceof Error ? error.message.slice(0, 80) : "error"})`);
    d.run.notes["step5-protection"] = tried;
    say(`step 5: branch protection ${tried}`);
  }
  // Demo reopens the task: the new head's check waits again.
  await sendMessage(demo, taskId, "Also mention `apiVersion` in test1's README");
  await waitFor("the reopened turn", 5 * 60_000, async () => ((await d.db.turn.count({ where: { taskId } })) >= 2 ? true : null), 3000);
  await settled(d, taskId);
  const number = Number(d.id(`pr:step4:${settings.githubRepo}`));
  const after = await waitFor("the check on the new head", 5 * 60_000, async () => {
    const found = await checkOnHead(d, settings.githubRepo, number);
    return found.status === null ? null : found;
  }, 5000).catch(() => null);
  d.check("step 5: after the reopen, the new head's check waits again", after !== null && after.status !== "completed", after === null ? "no check" : `${after.sha.slice(0, 7)}: ${after.status ?? ""}`);
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step05-reopened");
};

/** Step 5's end: both PRs merged (with the App's token: no test token), the task merged, the ticket done. */
export const mergeBoth = async (d: Demo): Promise<void> => {
  const { demo, settings, github } = d;
  const taskId = d.id("task:step4");
  for (const repo of [settings.githubRepo, settings.githubOtherRepo]) {
    const number = Number(d.id(`pr:step4:${repo}`));
    const pull = await github.octokit.rest.pulls.get({ owner: github.owner, repo, pull_number: number });
    if (pull.data.merged) continue;
    await github.octokit.rest.pulls.merge({ owner: github.owner, repo, pull_number: number, merge_method: "squash" });
    say(`step 5: merged ${repo}#${String(number)}`);
  }
  const state = await waitFor("the task merged", 6 * 60_000, async () => {
    const row = await d.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { state: true } });
    return row.state === "merged" || row.state === "done" ? row.state : null;
  }, 5000).catch(() => "not merged");
  d.check("step 5: the task is merged", state === "merged" || state === "done", state);
  const made = await ticket(d, "step4", STEP4_TITLE, STEP4_TEXT);
  const done = await waitFor("the ticket done", 4 * 60_000, async () => {
    const issue = await readIssue(d.tool, made.id);
    return issue.state.type === "completed" ? issue.state.name : null;
  }, 10_000).catch(() => "not done");
  d.check("step 5: the ticket moves to done", done !== "not done", done);
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step05-merged");
};

/**
 * Step 5's reopen, on step 8's task: step 4's task was merged before its reopen ran (the composer's
 * "Reopen" wasn't the script's "Send"), so the new head's check is shown on test1's PR of step 8.
 */
export const reopenCheck = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const taskId = d.id("task:step8");
  const pr = await d.db.taskPullRequest.findFirst({ where: { taskRepo: { taskId, repo: { fullName: `${settings.githubOrg}/${settings.githubRepo}` } } }, select: { number: true } });
  if (pr === null) throw new Error("step 8's task has no PR in test1");
  const before = await checkOnHead(d, settings.githubRepo, pr.number);
  const turns = await d.db.turn.count({ where: { taskId } });
  await sendMessage(demo, taskId, "Also mention the `release` key in test1's README");
  await waitFor("the reopened turn", 8 * 60_000, async () => ((await d.db.turn.count({ where: { taskId } })) > turns ? true : null), 3000);
  await settled(d, taskId);
  const after = await waitFor("the check on the new head", 5 * 60_000, async () => {
    const found = await checkOnHead(d, settings.githubRepo, pr.number);
    return found.sha !== before.sha && found.status !== null ? found : null;
  }, 5000).catch(() => null);
  d.check("step 5: after a reopen, the new head's check waits again", after !== null && after.status !== "completed", after === null ? `no new head (was ${before.sha.slice(0, 7)})` : `${before.sha.slice(0, 7)} → ${after.sha.slice(0, 7)}: ${after.status ?? ""}, ${after.title ?? ""}`);
  await demo.goto(`/tasks/${taskId}`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step05-reopened");
};
