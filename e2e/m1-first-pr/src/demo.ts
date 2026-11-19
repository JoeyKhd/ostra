// `pnpm e2e:m1` (ticket 39): milestone 1's demo (spec section 3), on this machine, against a
// running dev stack (`pnpm dev`) and the test org. It drives the panel in Chromium: the first
// admin, the model provider, the GitHub App, the project and its environment, the runner's device
// approval and the prompt. It starts `ostra runner` on the host executor, waits for the PR, and
// keeps screenshots under the spec folder. Every step that already happened is skipped, so a run
// can pick up where the last one stopped.
//
// Secrets come from the environment (loaded from ~/.config/ostra-dev/) and are typed into forms
// only: never printed. Run it with model.env, github.env and github-test.env loaded.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";
import type { TaskId } from "@ostra/protocol";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import {
  checkAgentTokenCount,
  checkGitProxy,
  checkNoCredential,
  checkLeftovers,
  checkNoEmptyPr,
  checkPullRequest,
  checkStoppedMidTurn,
  checkStoppedRefs,
  checkTaskFolder,
  checkTokens,
  taskCheckout,
  waitForSessionsEnded,
} from "./checks.ts";
import type { CheckResult } from "./checks.ts";
import { cleanUp, demoGitHub } from "./github.ts";
import type { DemoGitHub } from "./github.ts";
import { demoSettings } from "./settings.ts";
import type { DemoSettings } from "./settings.ts";
import type { RunningRunner } from "./runner.ts";
import { addModelProvider, connectGitHub, connectRunner, createProject, loadState, say, screenshot, signInAsAdmin, startTask, waitForPath } from "./setup.ts";

/** Step 8: a second tab shows the same thread, and a reload mid-turn brings the history back. */
const secondViewer = async (context: BrowserContext, page: Page, settings: DemoSettings): Promise<void> => {
  const second = await context.newPage();
  await second.goto(page.url());
  await second.locator('[data-part="tool"]').first().waitFor({ state: "attached", timeout: 60_000 });
  await screenshot(second, settings, "second-tab");
  await second.close();
  await page.reload();
  await page.locator('[data-part="tool"]').first().waitFor({ state: "attached", timeout: 60_000 });
  await screenshot(page, settings, "after-reload");
};

const watchUntilPullRequest = async (context: BrowserContext, page: Page, settings: DemoSettings, timeoutMs: number): Promise<string> => {
  const started = Date.now();
  let next = 0;
  let viewed = false;
  while (Date.now() - started < timeoutMs) {
    const link = page.getByTestId("pr-link").first();
    if ((await link.count()) > 0) {
      const href = await link.getAttribute("href");
      if (href !== null) {
        await screenshot(page, settings, "pull-request");
        return href;
      }
    }
    if (!viewed && (await page.locator('[data-part="tool"]').count()) > 0) {
      viewed = true;
      await secondViewer(context, page, settings);
    }
    if (Date.now() >= next) {
      await screenshot(page, settings, "watching");
      next = Date.now() + 30_000;
    }
    await page.waitForTimeout(2000);
  }
  await screenshot(page, settings, "timed-out");
  throw new Error("no pull request in time");
};

/** A task whose prompt asks only for an explanation: it ends without changes and lands in needs you. */
const emptyTask = async (page: Page, settings: DemoSettings, projectHref: string): Promise<TaskId> => {
  const taskId = await startTask(page, settings, projectHref, "In two sentences, explain what this repository is for. Only answer: do not create, change or commit any file.");
  await page.getByTestId("needs-you").waitFor({ timeout: 15 * 60_000 });
  await screenshot(page, settings, "needs-you");
  return taskId;
};

/** A task stopped mid-turn; while it runs, the git proxy is tried from its checkout, and its folders, its agent's environment and its token count are checked. */
const stoppedTask = async (
  page: Page,
  settings: DemoSettings,
  github: DemoGitHub,
  runner: RunningRunner,
  projectHref: string,
): Promise<{ readonly taskId: TaskId; readonly live: readonly CheckResult[] }> => {
  const taskId = await startTask(
    page,
    settings,
    projectHref,
    `Create docs/numbers.md listing the numbers one to ten as words, one per line. Then run this shell command in the foreground and wait for it to finish; it waits ten minutes. Don't move it to the background. node -e "setTimeout(() => {}, 600000)"`,
  );
  // The git proxy lives as long as the task: tried as soon as the agent is at work.
  await page.locator('[data-part="tool"]').first().waitFor({ state: "attached", timeout: 10 * 60_000 });
  await waitForPath(taskCheckout(settings, taskId), 60_000);
  const proxy = await checkGitProxy(github, settings, taskId);
  // Stopped while the agent's command waits, after it wrote the file: the unfinished work the hidden ref keeps.
  await page.locator('[data-part="tool"]', { hasText: "setTimeout" }).first().waitFor({ timeout: 10 * 60_000 });
  // Every model call is done: the agent waits on its command. Its folders and environment still exist.
  const folder = await checkTaskFolder(settings, taskId, runner.pid);
  const tokens = await checkAgentTokenCount(settings, taskId);
  await screenshot(page, settings, "before-stop");
  await page.locator('[data-action="stop"]').click();
  await page.getByText("Stopped").first().waitFor({ timeout: 5 * 60_000 });
  // The hidden ref is pushed as the run ends.
  await page.waitForTimeout(10_000);
  await screenshot(page, settings, "stopped");
  return { taskId, live: [...proxy, ...folder, tokens] };
};

const pullNumber = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? Number.NaN);

const main = async (): Promise<void> => {
  const settings = demoSettings(process.env);
  await mkdir(settings.screenshotDir, { recursive: true });
  const state = await loadState(path.join(settings.dataDir, "e2e-m1", "state.json"));
  const github = await demoGitHub(settings);
  let browser: Browser | null = null;
  let runner: RunningRunner | null = null;
  const checks: CheckResult[] = [];
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ baseURL: settings.panelUrl, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await signInAsAdmin(page, settings, state);
    await screenshot(page, settings, "checklist");
    await addModelProvider(page, settings);
    await connectGitHub(page, settings);
    const projectHref = await createProject(page, settings);
    runner = await connectRunner(page, settings);

    const taskId = await startTask(page, settings, projectHref, settings.prompt);
    const pr = await watchUntilPullRequest(context, page, settings, 20 * 60_000);
    say(`pull request: ${pr}`);
    const prNumber = pullNumber(pr);
    if (!Number.isInteger(prNumber)) throw new Error("the PR link has no number");
    checks.push(
      await checkPullRequest(github, prNumber, { botLogin: github.botLogin, adminUsername: settings.adminUsername, publicUrl: settings.publicUrl, taskId, prompt: settings.prompt }),
    );
    checks.push(await checkTokens(taskId));

    if (process.argv.includes("--checks")) {
      // The runner has one slot, and a finished turn's box keeps it warm for the idle timer (F-096):
      // each next task starts once the last one's box has stopped.
      say(`waiting for task ${taskId}'s box to stop (OSTRA_BOX_IDLE_MINUTES=${String(settings.idleMinutes)})`);
      await waitForSessionsEnded([taskId], settings.idleMinutes);
      const empty = await emptyTask(page, settings, projectHref);
      checks.push(await checkNoEmptyPr(github, empty));
      say(`waiting for task ${empty}'s box to stop`);
      await waitForSessionsEnded([empty], settings.idleMinutes);
      const stopped = await stoppedTask(page, settings, github, runner, projectHref);
      checks.push(...stopped.live, await checkStoppedMidTurn(github, stopped.taskId), await checkStoppedRefs(github, stopped.taskId));
      const all = [taskId, empty, stopped.taskId];
      await waitForSessionsEnded(all, settings.idleMinutes);
      checks.push(await checkNoCredential(settings, settings.logFiles), await checkLeftovers(settings, all, runner.pid));
    }
    for (const check of checks) say(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    await writeFile(path.join(settings.dataDir, "e2e-m1", "result.json"), JSON.stringify({ taskId, pullRequest: pr, checks }, null, 2));
    if (process.argv.includes("--clean-up")) {
      const cleaned = await cleanUp(github, new Set([prNumber]));
      say(`clean-up: closed ${String(cleaned.closed)} PRs, deleted ${String(cleaned.deleted)} refs; kept ${pr}`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  } finally {
    await browser?.close();
    await runner?.stop();
  }
};

await main();

