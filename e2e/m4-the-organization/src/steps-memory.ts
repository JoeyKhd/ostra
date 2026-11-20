import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Page } from "@playwright/test";

import type { Demo } from "./context.ts";
import { waitFor } from "./state.ts";
import { auditSince, sendMessage, settled, startFromInbox, startPromptTask, ticket } from "./tasks.ts";

// Spec section 3, steps 7 to 9: memory notes, a proposal approved, and memory reaching the next task.

const run = promisify(execFile);

export const NOTE_ORG = "Dates are written YYYY-MM-DD";
export const NOTE_NODE = "Check JavaScript with node";
/** A GitHub token's shape, made up: what the secret scan must refuse (never a real token). */
export const FAKE_TOKEN = `ghp_${"Demo4FakeTokenNotReal".padEnd(36, "x")}`;

/** "New note" on a Memory page; `true` when it saved. */
const newNote = async (page: Page, base: string, note: { readonly title: string; readonly body: string; readonly kind: string; readonly always: boolean }): Promise<boolean> => {
  await page.goto(`${base}/memory/new`);
  await page.getByRole("heading", { level: 1, name: "New note" }).waitFor({ timeout: 30_000 });
  await page.getByLabel("Title").fill(note.title);
  await page.getByLabel("Body").fill(note.body);
  await page.getByLabel("Kind").click();
  await page.getByRole("option", { name: note.kind }).click();
  if (note.always) await page.getByTestId("note-editor-always").click();
  await page.getByTestId("save-note").click();
  return page.getByText("Saved as version 1.").waitFor({ timeout: 15_000 }).then(() => true, () => false);
};

/** Step 7: an organization note (always), a test1 command note, and a refused note with a token. */
export const notes = async (d: Demo): Promise<void> => {
  const { demo } = d;
  const test1 = d.id("project:test1");
  if ((await d.db.memoryNote.count({ where: { title: NOTE_ORG } })) === 0) {
    await newNote(demo, "/organization", { title: NOTE_ORG, body: "Write every date as YYYY-MM-DD, for example 2026-11-20.", kind: "Convention", always: true });
  }
  await d.shot(demo, "step07-org-note");
  if ((await d.db.memoryNote.count({ where: { title: NOTE_NODE } })) === 0) {
    await newNote(demo, `/projects/${test1}`, { title: NOTE_NODE, body: "Run `node --check <file>` on every JavaScript file you change.", kind: "Command", always: false });
  }
  await d.shot(demo, "step07-test1-note");
  const org = await d.db.memoryNote.findFirst({ where: { title: NOTE_ORG }, select: { scope: true, kind: true, always: true } });
  const node = await d.db.memoryNote.findFirst({ where: { title: NOTE_NODE }, select: { scope: true, kind: true, projectId: true } });
  d.check("step 7: the organization's note is a convention, always on", org?.scope === "organization" && org.kind === "convention" && org.always, JSON.stringify(org));
  d.check("step 7: test1's note is a command", node?.kind === "command" && node.projectId === test1, JSON.stringify(node));
  const saved = await newNote(demo, `/projects/${test1}`, { title: "GitHub access for tests", body: `Tests that call GitHub read GITHUB_TOKEN=${FAKE_TOKEN}`, kind: "Gotcha", always: false });
  const refusal = await demo.getByTestId("note-secret").innerText().catch(() => "");
  d.check("step 7: a note holding the fake GitHub token is refused", !saved && refusal.includes("This note holds a GitHub token") && refusal.includes("Memory never holds credentials"), refusal.replace(/\s+/g, " ").slice(0, 120));
  await d.shot(demo, "step07-token-refused");
  await demo.goto(`/projects/${test1}/memory`);
  await demo.getByTestId("memory-search").fill("node");
  await demo.waitForTimeout(1500);
  const found = await demo.getByTestId("memory-list").locator(`[data-note="${NOTE_NODE}"]`).count();
  d.check("step 7: searching test1's Memory for node finds the command note", found > 0, `${String(found)} match`);
  await d.shot(demo, "step07-search-node");
};

export const STEP8_TITLE = "Rename releaseName to release";
export const STEP8_TEXT =
  "Rename the `releaseName` key in `config/settings.json` to `release`. Before you finish, propose a memory note titled 'Settings keys' saying that keys in `config/settings.json` are single lowercase words.";

/** Step 8: a ticket whose agent proposes a note; Sam approves it. */
export const proposal = async (d: Demo): Promise<void> => {
  const { demo, settings } = d;
  const test1 = d.id("project:test1");
  const made = await ticket(d, "step8", STEP8_TITLE, STEP8_TEXT);
  if (d.run.ids["task:step8"] === undefined) {
    d.run.ids["task:step8"] = await startFromInbox(d, demo, test1, made.identifier, settings.runnerName);
    await d.save();
  }
  const taskId = d.id("task:step8");
  await settled(d, taskId);
  if ((await d.db.memoryProposal.count({ where: { taskId } })) === 0) {
    // The agent may decline a ticket's request to write memory (ticket text is data, not an
    // instruction), and step 4's `apiVersion` makes "single lowercase words" untrue: Demo, a member,
    // asks for it in the task instead, with the rule that holds.
    d.run.notes["step8-asked"] = "the agent declined the ticket's request (ticket text isn't an instruction, and apiVersion isn't one lowercase word); Demo asked in the task";
    const turns = await d.db.turn.count({ where: { taskId } });
    await sendMessage(demo, taskId, "Please propose a memory note titled 'Settings keys' saying that keys in `config/settings.json` are camelCase words.");
    await waitFor("the asked turn", 8 * 60_000, async () => ((await d.db.turn.count({ where: { taskId } })) > turns ? true : null), 3000);
    await settled(d, taskId);
  }
  const calls = await d.db.event.findMany({ where: { taskId, kind: { startsWith: "tool." } }, select: { kind: true, payload: true } });
  const proposeCall = calls.some((one) => JSON.stringify(one.payload).includes("memory_propose"));
  d.check("step 8: the event log shows the agent's memory_propose call", proposeCall, `${String(calls.length)} tool events`);
  await demo.goto(`/tasks/${taskId}?tab=events`);
  await demo.waitForLoadState("networkidle");
  await d.shot(demo, "step08-event-log");
  const proposalRow = await waitFor("the proposal", 60_000, async () => d.db.memoryProposal.findFirst({ where: { taskId }, select: { id: true, title: true, state: true } }), 3000).catch(() => null);
  d.check("step 8: the agent's proposal is stored, from that task", proposalRow !== null, proposalRow === null ? "none" : `"${proposalRow.title}" ${proposalRow.state}`);
  await demo.goto(`/projects/${test1}/memory`);
  await demo.waitForLoadState("networkidle");
  const link = (await demo.getByTestId("proposals-link").innerText().catch(() => "")).replace(/\s+/g, "");
  d.check("step 8: test1's Memory shows 1 proposal", link === "Proposals1", link);
  await d.shot(demo, "step08-memory-proposals-count");
  if (proposalRow === null) return;
  const sam = await d.page("sam");
  const since = Date.now();
  await sam.goto(`/projects/${test1}/memory/proposals`);
  await sam.waitForLoadState("networkidle");
  await sam.locator(`[data-proposal="${proposalRow.title}"]`).first().click().catch(() => undefined);
  const detail = sam.getByTestId("proposal-detail");
  await detail.waitFor({ timeout: 30_000 });
  await d.shot(sam, "step08-sam-proposal");
  if (proposalRow.state === "proposed") {
    await detail.getByTestId("approve-proposal").click();
    await sam.getByTestId("note-panel").waitFor({ timeout: 30_000 }).catch(() => undefined);
  }
  await d.shot(sam, "step08-sam-approved");
  const after = await d.db.memoryProposal.findUniqueOrThrow({ where: { id: proposalRow.id }, select: { state: true, resultNoteId: true } });
  d.check("step 8: Sam's approval makes it a note", after.state === "approved" && after.resultNoteId !== null, after.state);
  const actions = (await auditSince(d, since)).map((entry) => entry.action);
  d.check("step 8: the audit log has the decision", actions.includes("memory.proposal-approved"), actions.join(", "));
};

/** Step 9: Sam's task gets the index and the always note, uses the command note, and leaves no memory file. */
export const reachesNextTask = async (d: Demo): Promise<void> => {
  const { settings } = d;
  const test1 = d.id("project:test1");
  const sam = await d.page("sam");
  if (d.run.ids["task:step9"] === undefined) {
    d.run.ids["task:step9"] = await startPromptTask(sam, test1, "Add `scripts/print-release.js`, which prints the `release` key of `config/settings.json`, and a line to `CHANGELOG.md` with today's date.", settings.secondRunner.runnerName);
    await d.save();
  }
  const taskId = d.id("task:step9");
  await settled(d, taskId);
  // The config folder holds the index and the always note; no repo has a memory file.
  const taskDir = path.join(settings.secondRunner.runnerDataDir, "tasks", taskId);
  const walk = async (dir: string, depth: number): Promise<string[]> => {
    if (depth > 4) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full, depth + 1)));
      else out.push(full);
    }
    return out;
  };
  const files = await walk(taskDir, 0);
  let instructionsHold = false;
  for (const file of files.filter((one) => !one.includes(`${path.sep}workspace${path.sep}`))) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes(NOTE_ORG) && text.includes(NOTE_NODE) && text.includes("YYYY-MM-DD")) instructionsHold = true;
  }
  d.check("step 9: the session's instructions hold the index and the always note, outside the repos", instructionsHold, `${String(files.length)} files in the task's folder`);
  const repoFiles: string[] = [];
  for (const repo of [settings.githubRepo, settings.githubOtherRepo]) {
    const dir = path.join(taskDir, "workspace", repo);
    const status = await run("git", ["-C", dir, "status", "--porcelain", "--ignored"], { windowsHide: true }).then((out) => out.stdout, () => "");
    for (const line of status.split("\n")) if (/memory|MEMORY|AGENTS\.md|ostra/i.test(line)) repoFiles.push(`${repo}: ${line.trim()}`);
  }
  d.check("step 9: no repo has a memory file", repoFiles.length === 0, repoFiles.length === 0 ? "git status clean of it in both repos" : repoFiles.join("; "));
  const events = await d.db.event.findMany({ where: { taskId, kind: { startsWith: "tool." } }, select: { payload: true } });
  const ranCheck = events.some((one) => /node --check[^"]*print-release/.test(JSON.stringify(one.payload)));
  d.check("step 9: the agent runs node --check scripts/print-release.js", ranCheck, `${String(events.length)} tool events`);
  const changelog = await readFile(path.join(taskDir, "workspace", settings.githubRepo, "CHANGELOG.md"), "utf8").catch(() => "");
  const dated = /\b20\d\d-\d\d-\d\d\b/.test(changelog.split("\n").slice(0, 12).join("\n"));
  d.check("step 9: the changelog line's date reads YYYY-MM-DD", dated, dated ? "a YYYY-MM-DD date near the top" : "no such date");
  const uses = await d.db.memoryUse.findMany({ where: { taskId }, select: { via: true, note: { select: { title: true } } } });
  d.check("step 9: the task records the notes the session used, and how", uses.length > 0, uses.map((use) => `${use.note.title} (${use.via})`).join(", ") || "none");
  await sam.goto(`/tasks/${taskId}`);
  await sam.waitForLoadState("networkidle");
  await d.shot(sam, "step09-task-memory");
};
