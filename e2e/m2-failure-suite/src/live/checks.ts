import { PROGRESS_COMMENT_MARKER } from "@ostra/domain";
import type { CheckResult } from "@ostra/e2e-m1/checks";
import { readIssue } from "@ostra/e2e-m2/linear";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { TicketTask } from "./tasks.ts";
import type { World } from "./world.ts";

// What every case checks after it (ticket 38, spec section 3): every event the server received is
// stored exactly once, nothing is doubled on Linear, on GitHub or in the tracker writer's outbox,
// and the task ends where it should. Each check reads the database the stack writes, and Linear and
// GitHub as the test tool sees them.

/** A move's payload in the outbox: where it moved the ticket. */
const moveTargetSchema = z.looseObject({ target: z.string() });

/** A runner's events of each session: numbered 1 to n with no gap and none twice, and the cursor at n. */
export const checkEventsOnce = async (world: World, taskId: TaskId): Promise<CheckResult> => {
  const sessions = await world.db.session.findMany({ where: { taskId }, select: { id: true, ingestedSeq: true } });
  const problems: string[] = [];
  let total = 0;
  for (const session of sessions) {
    const rows = await world.db.event.findMany({ where: { sessionId: session.id, sessionSeq: { not: null } }, orderBy: { sessionSeq: "asc" }, select: { sessionSeq: true } });
    const seqs = rows.map((row) => row.sessionSeq ?? 0);
    total += seqs.length;
    const contiguous = seqs.every((seq, index) => seq === index + 1);
    if (!contiguous) problems.push(`session ${session.id} has a gap or a repeat`);
    if (seqs.length !== session.ingestedSeq) problems.push(`session ${session.id} stored ${String(seqs.length)} events, its cursor says ${String(session.ingestedSeq)}`);
  }
  // A server event core writes once per fact: one `pr.opened` per PR.
  const opened = await world.db.event.count({ where: { taskId, kind: "pr.opened" } });
  const prs = await world.db.taskRepo.count({ where: { taskId, prNumber: { not: null } } });
  if (opened !== prs) problems.push(`${String(opened)} pr.opened events for ${String(prs)} PRs`);
  return {
    name: "every event stored exactly once",
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${String(total)} runner events in ${String(sessions.length)} sessions, numbered without a gap or a repeat; ${String(opened)} pr.opened` : problems.join("; "),
  };
};

/** On Linear, in the outbox and on GitHub: one comment, one link per URL, no status set twice in a row, one PR. */
export const checkNoDoubles = async (world: World, task: TicketTask): Promise<CheckResult> => {
  const taskUrl = `${world.m2.publicUrl}/tasks/${task.taskId}`;
  const problems: string[] = [];
  const issue = await readIssue(world.tool, task.issueId);
  // The progress comment, edited in place, and the needs-you notices (ADR 0050), each said once.
  const ours = issue.comments.nodes.filter((comment) => comment.body.includes(taskUrl));
  const comments = ours.filter((comment) => comment.body.includes(PROGRESS_COMMENT_MARKER)).length;
  if (comments > 1) problems.push(`${String(comments)} progress comments`);
  const bodies = ours.map((comment) => comment.body);
  const repeatedNotices = bodies.filter((body, index) => bodies.indexOf(body) !== index).length;
  if (repeatedNotices > 0) problems.push(`${String(repeatedNotices)} comments posted twice`);
  const urls = issue.attachments.nodes.map((attachment) => attachment.url);
  const doubled = urls.filter((url, index) => urls.indexOf(url) !== index);
  if (doubled.length > 0) problems.push(`${String(doubled.length)} links made twice`);
  const moves = issue.history.nodes.filter((entry) => entry.toState !== null).map((entry) => entry.toState?.id ?? "");
  const repeated = moves.filter((state, index) => index > 0 && moves[index - 1] === state).length;
  if (repeated > 0) problems.push(`${String(repeated)} status changes to the state it was in`);
  // Linear folds one user's edits made close together into one history entry (the dev seed's
  // connection writes as the maintainer, who also made the ticket), so its history can show fewer
  // moves than were made: the outbox's moves, in order, are checked as well.
  const writes = await world.db.ticketWrite.findMany({ where: { taskId: task.taskId }, orderBy: { createdAt: "asc" }, select: { kind: true, state: true, idempotencyKey: true, payload: true } });
  const targets = writes.filter((write) => write.kind === "move").map((write) => moveTargetSchema.safeParse(write.payload).data?.target ?? "");
  const movedTwice = targets.filter((target, index) => index > 0 && targets[index - 1] === target).length;
  if (movedTwice > 0) problems.push(`${String(movedTwice)} moves in the outbox to the status before it`);
  const count = (kind: string): number => writes.filter((write) => write.kind === kind).length;
  if (count("comment") > 1) problems.push(`${String(count("comment"))} comment writes`);
  if (count("link_task") > 1) problems.push(`${String(count("link_task"))} task-link writes`);
  const failed = writes.filter((write) => write.state === "failed").length;
  if (failed > 0) problems.push(`${String(failed)} ticket writes failed`);
  const pulls = await world.github.octokit.rest.pulls.list({ owner: world.github.owner, repo: world.github.repo, state: "all", head: `${world.github.owner}:${task.branch}`, per_page: 20 });
  if (pulls.data.length > 1) problems.push(`${String(pulls.data.length)} PRs for ${task.branch}`);
  return {
    name: "nothing doubled (F-046)",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${task.identifier}: ${String(comments)} progress comment, ${String(ours.length - comments)} notices, ${String(urls.length)} links each made once, ${String(moves.length)} status changes in Linear's history and ${String(targets.length)} moves in the outbox (${targets.join(", ")}); ${String(writes.length)} tracker writes; ${String(pulls.data.length)} PR on GitHub`
        : problems.join("; "),
  };
};

/** Linear's deliveries: each stored once by its ID, and each processed. */
export const checkDeliveriesOnce = async (world: World): Promise<CheckResult> => {
  const rows = await world.db.webhookDelivery.findMany({ where: { connectionId: world.connectionId }, select: { deliveryId: true, status: true } });
  const ids = new Set(rows.map((row) => row.deliveryId));
  const unprocessed = rows.filter((row) => row.status !== "processed").length;
  return {
    name: "every webhook stored once",
    ok: ids.size === rows.length && unprocessed === 0,
    detail: `${String(rows.length)} deliveries, ${String(ids.size)} distinct, ${String(unprocessed)} not processed`,
  };
};

export const check = (name: string, ok: boolean, detail: string): CheckResult => ({ name, ok, detail });
