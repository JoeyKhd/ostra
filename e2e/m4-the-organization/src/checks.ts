import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Page } from "@playwright/test";

import type { Demo } from "./context.ts";
import { FAKE_TOKEN } from "./steps-memory.ts";

// Spec section 3, the checks after the run that the script makes on the live stack (ticket 41):
// nothing leaked, searched by value and never printed; and the sweep of list procedures as Sam
// and Rae for vault's IDs. The rest of the list is proved by the suites the record names.

/** Every list read a member's panel makes with no project named, and the ones of each open project. */
const sweepCalls = (projectIds: readonly string[]): readonly { readonly procedure: string; readonly input?: unknown }[] => [
  { procedure: "projects.list" },
  { procedure: "home.overview" },
  { procedure: "home.needsYou", input: {} },
  { procedure: "home.board", input: {} },
  { procedure: "notifications.list", input: { tab: "open" } },
  { procedure: "notifications.list", input: { tab: "done" } },
  { procedure: "members.list" },
  { procedure: "memory.notes", input: { scope: "organization" } },
  { procedure: "search.tasks", input: { query: "VAULT" } },
  { procedure: "search.tasks", input: { query: "notes.txt" } },
  { procedure: "search.suggest", input: { query: "VAULT-ONLY" } },
  { procedure: "insights.get", input: { projectId: null, period: { kind: "preset", days: 30 } } },
  ...projectIds.flatMap((projectId) => [
    { procedure: "tasks.list", input: { projectId } },
    { procedure: "memory.notes", input: { scope: "project", projectId } },
  ]),
];

/** The sweep as one member: `null` when nothing named vault, otherwise the procedures that did. */
export const sweepFor = async (d: Demo, page: Page, label: string): Promise<void> => {
  const vault = d.id("project:vault");
  const vaultTasks = (await d.db.task.findMany({ where: { projectId: vault }, select: { id: true } })).map((task) => task.id);
  // Every project but vault: a restricted one the member isn't listed on answers NOT_FOUND.
  const others = (await d.db.project.findMany({ where: { id: { not: vault } }, select: { id: true } })).map((project) => project.id);
  const leaks: string[] = [];
  const malformed: string[] = [];
  let answered = 0;
  const calls = sweepCalls(others);
  for (const call of calls) {
    const answer = await d.query(page, call.procedure, call.input);
    if (!answer.ok) {
      if (answer.code !== "NOT_FOUND") malformed.push(`${call.procedure} ${answer.code}`);
      continue;
    }
    answered += 1;
    const text = JSON.stringify(answer.data);
    if (text.includes(vault) || vaultTasks.some((id) => text.includes(id)) || text.includes("VAULT-ONLY-7731")) leaks.push(call.procedure);
  }
  d.check(
    `after: the sweep of list procedures as ${label} returns none of vault's IDs`,
    leaks.length === 0 && malformed.length === 0 && answered > calls.length / 2,
    leaks.length > 0 ? `vault in ${leaks.join(", ")}` : malformed.length > 0 ? `refused: ${malformed.join(", ")}` : `${String(answered)} of ${String(calls.length)} reads answered, none name vault`,
  );
};

const filesUnder = async (dir: string, depth = 0): Promise<string[]> => {
  if (depth > 8) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full, depth + 1)));
    else out.push(full);
  }
  return out;
};

/** A bearer link's secret parts: its long path segments (an invitation's ID) and its query values (a token). */
const bearerParts = (link: string): readonly string[] => {
  try {
    const url = new URL(link);
    return [...url.pathname.split("/").filter((part) => part.length >= 16), ...[...url.searchParams.values()].filter((value) => value.length >= 16)];
  } catch {
    return [];
  }
};

/** Nothing leaked: each secret the run handled, searched by value in the logs, the events, the notes and the worktrees. */
export const nothingLeaked = async (d: Demo): Promise<void> => {
  const { settings } = d;
  const values = [
    { name: "the model key", value: settings.modelApiKey },
    { name: "the Linear key", value: settings.linearApiKey },
    { name: "step 7's fake GitHub token", value: FAKE_TOKEN },
    ...d.secrets.flatMap((link, index) => bearerParts(link).map((value) => ({ name: `bearer link ${String(index + 1)}`, value }))),
  ].filter((one) => one.value.length >= 12);
  // The stack's log, and the logs of its earlier starts beside it (`stack-1.log`, …), when restarted.
  const stackLogs = (await Promise.all(settings.logFiles.map(async (file) => (await readdir(path.dirname(file)).catch(() => [])).filter((name) => /^stack.*\.log$/.test(name)).map((name) => path.join(path.dirname(file), name))))).flat();
  const files = [
    ...new Set([...settings.logFiles, ...stackLogs]),
    ...(await filesUnder(path.join(settings.runnerDataDir, "tasks"))),
    ...(await filesUnder(path.join(settings.secondRunner.runnerDataDir, "tasks"))),
  ];
  const found: string[] = [];
  let scanned = 0;
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (info === null || info.size > 50 * 1024 * 1024) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    scanned += 1;
    for (const one of values) if (text.includes(one.value)) found.push(`${one.name} in ${path.basename(file)}`);
  }
  const events = await d.db.event.findMany({ select: { payload: true } });
  const eventText = events.map((event) => JSON.stringify(event.payload)).join("\n");
  for (const one of values) if (eventText.includes(one.value)) found.push(`${one.name} in an event`);
  const notes = await d.db.memoryNote.findMany({ select: { body: true, title: true } });
  if (notes.some((note) => note.body.includes(FAKE_TOKEN) || note.title.includes(FAKE_TOKEN))) found.push("the fake token in a note");
  const proposals = await d.db.memoryProposal.findMany({ select: { body: true } });
  if (proposals.some((one) => one.body.includes(FAKE_TOKEN))) found.push("the fake token in a proposal");
  const audit = await d.db.auditEntry.findMany({ select: { data: true } });
  const auditText = audit.map((entry) => JSON.stringify(entry.data)).join("\n");
  for (const one of values) if (auditText.includes(one.value)) found.push(`${one.name} in the audit log`);
  d.check("after: nothing leaked (logs, events, notes, audit, worktrees, searched by value)", found.length === 0, found.length === 0 ? `${String(values.length)} values, ${String(scanned)} files, ${String(events.length)} events` : found.join("; "));
  // No note's text is in a repo or a commit: the worktrees hold no note body.
  const bodies = notes.map((note) => note.body).filter((body) => body.length >= 20);
  const inRepos: string[] = [];
  for (const file of files.filter((one) => one.includes(`${path.sep}workspace${path.sep}`))) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (bodies.some((body) => text.includes(body))) inRepos.push(path.basename(file));
  }
  d.check("after: no note's text is in a repo", inRepos.length === 0, inRepos.length === 0 ? "no worktree file holds a note's body" : inRepos.join(", "));
};
