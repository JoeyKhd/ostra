import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { say } from "@ostra/e2e-m1/setup";
import type { Page } from "@playwright/test";
import { z } from "zod";

import type { Demo } from "./context.ts";
import { seconds, sleep, waitFor } from "./run-state.ts";
import { eventsOf, taskIdOf, taskPath } from "./steps-task.ts";

// Spec section 3, steps 6 to 9: checks before the PR, the diff with comments, update branch, and
// take it local with `ostra login` and `ostra checkout`.

const git = promisify(execFile);

const prOf = async (d: Demo) => d.db.taskRepo.findFirst({ where: { taskId: taskIdOf(d) }, select: { prNumber: true, prUrl: true, branchName: true, headSha: true, behindBy: true, state: true } });

/** Waits until no turn runs and the task's session has nothing queued. */
export const turnSettled = async (d: Demo, timeoutMs: number): Promise<void> => {
  await waitFor("the turn's end", timeoutMs, async () => {
    const task = await d.db.task.findUniqueOrThrow({ where: { id: taskIdOf(d) }, select: { state: true } });
    return task.state === "running" || task.state === "preparing" || task.state === "queued" ? null : true;
  }, 5000);
};

/** Step 6: the checks after the turn, the PR with its Checks section, and the Checks tab. */
export const checks = async (d: Demo): Promise<void> => {
  const { sam } = d;
  const started = Date.now();
  const pr = await waitFor("the PR", 30 * 60_000, async () => {
    const row = await prOf(d);
    return row?.prNumber === null || row?.prNumber === undefined || row.prUrl === null ? null : { number: row.prNumber, url: row.prUrl };
  }, 10_000);
  d.run.pr = pr;
  d.run.timings["prSeconds"] = seconds(Date.now() - started);
  await d.save();
  say(`step 6: ${pr.url}`);
  await turnSettled(d, 20 * 60_000);
  const pull = await d.github.octokit.rest.pulls.get({ owner: d.github.owner, repo: d.github.repo, pull_number: pr.number });
  const body = pull.data.body ?? "";
  // ostra's Checks section escapes markdown in a check's name: `settings\-json`.
  const named = body.includes("### Checks") && body.includes("**whitespace**: ✅ passed") && /settings\\?-json\*\*: ✅ passed/.test(body);
  d.check("step 6: the PR body has a Checks section naming both as passed", named, named ? "whitespace and settings-json passed" : "no Checks section naming both");
  const finished = await d.db.checkRun.findMany({ where: { taskId: taskIdOf(d) }, select: { name: true, status: true, durationMs: true }, orderBy: { startedAt: "asc" } });
  d.check("step 6: both checks ran and passed", finished.some((run) => run.name === "whitespace" && run.status === "passed") && finished.some((run) => run.name === "settings-json" && run.status === "passed"), finished.map((run) => `${run.name} ${run.status}`).join(", "));
  d.check("step 6: the PR opened ready for review", !pull.data.draft, pull.data.draft === true ? "draft" : "ready");
  await sam.goto(`${taskPath(d)}?tab=checks`);
  await sam.waitForLoadState("networkidle");
  await sleep(1500);
  await d.shot(sam, "step06-checks-tab");
  const tab = await sam.locator("main").innerText();
  d.check("step 6: the Checks tab shows both", tab.includes("whitespace") && tab.includes("settings-json"), "both named in the tab");
};

/** Step 7: Sam comments on two lines and sends them as one message; the agent's commit updates the PR. */
export const diff = async (d: Demo): Promise<void> => {
  const { sam } = d;
  await turnSettled(d, 20 * 60_000);
  const before = await prOf(d);
  await sam.goto(`${taskPath(d)}?tab=changes`);
  const gutters = sam.getByRole("button", { name: /^Comment on line \d+$/ });
  await gutters.first().waitFor({ timeout: 120_000 });
  await d.shot(sam, "step07-changes-tab");
  const words = ["Keep the keys sorted.", "Say which tool gave the name."];
  for (const [index, text] of words.entries()) {
    const gutter = gutters.nth(index);
    await gutter.scrollIntoViewIfNeeded();
    await gutter.click();
    const field = sam.locator("[data-field] textarea");
    await field.fill(text);
    await sam.getByRole("button", { name: "Save draft" }).click();
    await sam.locator("[data-field]").waitFor({ state: "detached", timeout: 30_000 });
  }
  await d.shot(sam, "step07-two-drafts");
  await sam.getByRole("button", { name: /Send 2 comments to the agent/ }).click();
  await sam.getByText(/Sent 2 comments as one message/).waitFor({ timeout: 30_000 });
  const message = await waitFor("the comments' message", 60_000, async () => {
    const rows = await eventsOf(d, "user.message");
    return rows.find((row) => JSON.stringify(row.payload).includes("Keep the keys sorted")) ?? null;
  });
  const payload = JSON.stringify(message.payload);
  d.check("step 7: one member message carries both comments, as diff comments", payload.includes("Say which tool gave the name") && payload.includes("diff-comments"), "one message, intent diff-comments");
  // The agent's next commit updates the same PR.
  const moved = await waitFor("the PR's new head", 20 * 60_000, async () => {
    const now = await prOf(d);
    return now?.headSha !== null && now?.headSha !== before?.headSha ? now : null;
  }, 10_000);
  d.check("step 7: the agent's commit updates the same PR", moved.prNumber === before?.prNumber, `PR #${String(moved.prNumber)} head ${moved.headSha?.slice(0, 7) ?? ""}`);
  await turnSettled(d, 20 * 60_000);
  await sam.goto(`${taskPath(d)}?tab=changes`);
  await sam.waitForLoadState("networkidle");
  await sleep(3000);
  await d.shot(sam, "step07-comments-sent");
  const comments = await d.db.diffComment.findMany({ where: { taskId: taskIdOf(d) }, select: { state: true } });
  d.check("step 7: the comments show as sent", comments.length === 2 && comments.every((comment) => comment.state === "sent"), comments.map((comment) => comment.state).join(", "));
  await sam.goto(taskPath(d));
  await sam.waitForLoadState("networkidle");
  await d.shot(sam, "step07-activity");
};

/** Step 8: a commit on main makes the branch behind; Sam's Update branch merges it in. */
export const updateBranch = async (d: Demo): Promise<void> => {
  const { sam, github } = d;
  await turnSettled(d, 20 * 60_000);
  const file = `docs/upstream-${randomBytes(3).toString("hex")}.md`;
  await github.octokit.rest.repos.createOrUpdateFileContents({
    owner: github.owner,
    repo: github.repo,
    path: file,
    message: `Add ${file} upstream`,
    content: Buffer.from("A change on main while the task works.\n").toString("base64"),
    branch: "main",
  });
  const pushedAt = Date.now();
  say(`step 8: pushed ${file} to main`);
  const behind = await waitFor("the branch behind main", 10 * 60_000, async () => {
    const row = await prOf(d);
    return row?.behindBy !== null && row?.behindBy !== undefined && row.behindBy > 0 ? row.behindBy : null;
  }, 10_000);
  d.run.timings["behindSeenSeconds"] = seconds(Date.now() - pushedAt);
  d.check("step 8: the task says test1 is behind main", behind >= 1, `${String(behind)} commit behind after ${String(d.run.timings["behindSeenSeconds"])} s (the reconcile; the test App has no webhook)`);
  await sam.goto(`${taskPath(d)}?tab=changes`);
  const update = sam.getByRole("button", { name: "Update branch" });
  await update.waitFor({ timeout: 60_000 });
  await d.shot(sam, "step08-behind");
  await update.click();
  const message = await waitFor("update branch's message", 60_000, async () => {
    const rows = await eventsOf(d, "user.message");
    return rows.find((row) => JSON.stringify(row.payload).includes("update-branch")) ?? null;
  });
  d.check("step 8: Update branch sent one message", JSON.stringify(message.payload).includes("update-branch"), "a member message with intent update-branch");
  await sleep(10_000);
  await turnSettled(d, 20 * 60_000);
  const caughtUp = await waitFor("the branch caught up", 10 * 60_000, async () => {
    const row = await prOf(d);
    return row?.behindBy === 0 ? row : null;
  }, 15_000).catch(() => null);
  d.check("step 8: the PR is up to date", caughtUp !== null, caughtUp === null ? "still behind" : "0 behind main");
  await sam.goto(`${taskPath(d)}?tab=changes`);
  await sam.waitForLoadState("networkidle");
  await d.shot(sam, "step08-updated");
};

const cliEnv = (appData: string): NodeJS.ProcessEnv => ({ ...process.env, APPDATA: appData, XDG_CONFIG_HOME: path.join(appData, "xdg") });

const ostra = (args: readonly string[], appData: string, cwd: string) =>
  spawn(process.execPath, [path.join(repoRoot, "apps", "runner", "src", "main.ts"), ...args], { cwd, env: cliEnv(appData), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

const runOstra = async (args: readonly string[], appData: string, cwd: string): Promise<{ readonly code: number | null; readonly output: string }> => {
  const child = ostra(args, appData, cwd);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, output };
};

/** `ostra login` as Sam: the code shown, approved on the device page in Sam's browser. */
const loginAsSam = async (d: Demo, page: Page, appData: string): Promise<void> => {
  const child = ostra(["login", "--server", d.settings.publicUrl], appData, os.tmpdir());
  const code = new Promise<string>((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const found = /the code (\S+?)\.?$/.exec(line)?.[1];
      if (found !== undefined) resolve(found);
    });
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const userCode = await Promise.race([code, sleep(60_000).then(() => "")]);
  if (userCode === "") throw new Error("ostra login showed no code");
  await page.goto("/device");
  await page.locator("#user-code").fill(userCode);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("device-confirm").waitFor();
  await d.shot(page, "step09-device-cli");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText(/^Approved\./).waitFor();
  const exit = await Promise.race([exited, sleep(60_000).then(() => -1)]);
  if (exit !== 0) throw new Error(`ostra login exited ${String(exit)}`);
};

/** Step 9: Take it local, `ostra login` and `ostra checkout`, a hand-made commit, and the reopen. */
export const local = async (d: Demo): Promise<void> => {
  const { sam, github, settings } = d;
  await turnSettled(d, 20 * 60_000);
  await sam.goto(taskPath(d));
  await sam.getByRole("button", { name: "Take it local" }).click();
  await sam.getByText(/ostra checkout/).first().waitFor();
  await d.shot(sam, "step09-take-it-local");
  const key = d.run.ticket?.identifier ?? taskIdOf(d);
  d.check("step 9: Take it local shows the checkout line", (await sam.getByText(`ostra checkout ${key}`).count()) > 0, `ostra checkout ${key}`);
  await sam.keyboard.press("Escape");
  // A clone of test1 in a folder of Sam's, with the App's token as Sam's own git access on this machine.
  const work = path.join(os.tmpdir(), "ostra-e2e-m3", "sam-clones");
  const appData = path.join(os.tmpdir(), "ostra-e2e-m3", "sam-cli");
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await mkdir(appData, { recursive: true });
  const { token } = z.object({ token: z.string() }).parse(await github.octokit.auth({ type: "installation" }));
  const remote = `https://x-access-token:${token}@github.com/${github.owner}/${github.repo}.git`;
  await git("git", ["clone", "--quiet", remote, path.join(work, github.repo)], { windowsHide: true });
  await loginAsSam(d, sam, appData);
  const checkout = await runOstra(["checkout", key, "--dir", work], appData, work);
  const head = (await git("git", ["-C", path.join(work, github.repo), "rev-parse", "HEAD"], { windowsHide: true })).stdout.trim();
  const pr = await prOf(d);
  d.check("step 9: ostra checkout put the task's branch at the PR's head", checkout.code === 0 && head === pr?.headSha, `exit ${String(checkout.code)}, HEAD ${head.slice(0, 7)} vs PR ${pr?.headSha?.slice(0, 7) ?? "none"}`);
  // A hand-made commit, pushed as Sam's own git access.
  const clone = path.join(work, github.repo);
  const noteFile = `NOTES-${randomBytes(2).toString("hex")}.md`;
  await writeFile(path.join(clone, noteFile), "Sam's note: the release name came from the release-names tool.\n");
  await git("git", ["-C", clone, "add", noteFile], { windowsHide: true });
  await git("git", ["-C", clone, "-c", "user.name=Sam", "-c", `user.email=${settings.samEmail}`, "commit", "--quiet", "-m", "Add a note about the release name"], { windowsHide: true });
  await git("git", ["-C", clone, "push", "--quiet", "origin", "HEAD"], { windowsHide: true });
  const pushed = (await git("git", ["-C", clone, "rev-parse", "HEAD"], { windowsHide: true })).stdout.trim();
  say(`step 9: Sam pushed ${pushed.slice(0, 7)}`);
  // Sam reopens the task (or sends, when the session is still going) and asks about the commit.
  await sam.goto(taskPath(d));
  const box = sam.getByRole("textbox", { name: "Message the agent" });
  await box.fill("Read my last commit and say what it did.");
  const askedAfter = (await eventsOf(d, "user.message")).at(-1)?.seq ?? 0;
  const reopen = sam.locator('[data-action="reopen"]');
  if ((await reopen.count()) > 0) await reopen.click();
  else await sam.locator('[data-action="send"]').click();
  const origin = await waitFor("the reopen's session", 10 * 60_000, async () => {
    const rows = (await eventsOf(d, "session.restored")).filter((row) => row.seq > askedAfter);
    return rows.at(-1) === undefined ? null : (/"origin":"(\w+)"/.exec(JSON.stringify(rows.at(-1)?.payload))?.[1] ?? "unknown");
  }, 3000).catch(() => "none");
  const answer = await waitFor("the agent's answer about the commit", 20 * 60_000, async () => {
    const asked = (await eventsOf(d, "user.message")).findLast((row) => row.seq > askedAfter && JSON.stringify(row.payload).includes("Read my last commit"));
    if (asked === undefined) return null;
    const rows = (await eventsOf(d, "agent.message")).filter((row) => row.seq > asked.seq);
    const text = rows.map((row) => JSON.stringify(row.payload)).join(" ");
    return text.includes(noteFile) ? text : null;
  }, 10_000).catch(() => null);
  d.check(`step 9: the agent read the hand-made commit (the session ${origin})`, answer !== null, answer === null ? `no answer naming ${noteFile}` : `its answer names ${noteFile}`);
  await turnSettled(d, 20 * 60_000);
  await sam.goto(taskPath(d));
  await d.shot(sam, "step09-agent-read-commit");
  // Account: the CLI session, then Revoke, and the next checkout is refused.
  await sam.goto("/account");
  await sam.getByRole("button", { name: "Revoke" }).first().waitFor({ timeout: 30_000 });
  await d.shot(sam, "step09-account-cli-sessions");
  await sam.getByRole("button", { name: "Revoke" }).first().click();
  await sam.getByRole("alertdialog").getByRole("button", { name: /Revoke/ }).click();
  await sleep(2000);
  const refused = await runOstra(["checkout", key, "--dir", work], appData, work);
  d.check("step 9: after Revoke the next checkout is refused", refused.code !== 0, `exit ${String(refused.code)}`);
  await d.shot(sam, "step09-account-revoked");
};
