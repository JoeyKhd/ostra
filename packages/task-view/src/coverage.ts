import type { TaskEventKind } from "@ostra/protocol";

import type { TaskMessageMeta, TaskUIPart } from "./ui-types.ts";

// Where each event kind lands, so none is lost (milestone 10, F-151): a message of its own, a part
// (new, or an existing one it updates), a field of its turn, or the Event log only, which keeps
// every event (milestone 4) and is where bookkeeping is read. A missing kind is a type error, so a
// new kind in the protocol can't be forgotten here, and the fold's tests check each kind lands
// where this says (`fold.test.ts`).

/** Where the fold puts one event kind. `note` says more: its other places, and why. */
export type FoldPlace =
  /** A message of its own: a member's, or a turn's. */
  | { readonly in: "message"; readonly role: "user" | "assistant"; readonly note: string }
  /** A part, new or updated: one of `parts`, as the event's content decides. */
  | { readonly in: "part"; readonly parts: readonly TaskUIPart["type"][]; readonly note: string }
  /** A field of its turn's metadata, for the footer, the tooltip and the panel. */
  | { readonly in: "turn"; readonly field: keyof TaskMessageMeta; readonly note: string }
  /** Nothing in the thread: the Event log has it, and the panel reads it elsewhere when it needs it. */
  | { readonly in: "event-log"; readonly note: string };

const message = (role: "user" | "assistant", note = ""): FoldPlace => ({ in: "message", role, note });
const part = (parts: readonly TaskUIPart["type"][], note = ""): FoldPlace => ({ in: "part", parts, note });
const turn = (field: keyof TaskMessageMeta, note = ""): FoldPlace => ({ in: "turn", field, note });
const eventLog = (note: string): FoldPlace => ({ in: "event-log", note });

const toolParts = ["tool-read", "tool-edit", "tool-execute", "dynamic-tool"] as const;

export const foldCoverage = {
  "user.message": message("user"),
  "turn.started": message("assistant", "its number across the sessions is `meta.ordinal`"),
  "turn.ended": turn("turnState", "with `stopReason` and `endedAt`"),
  "turn.failed": turn("error", "with `turnState` and `endedAt`"),
  "turn.cancel_requested": part(["data-system"], "a member asked the agent to stop"),
  "agent.message": part(["text"], "a subagent's answer is its window's (`meta.subagents`)"),
  "agent.thought": part(["reasoning"], "its time is `meta.stepTimes`; a subagent's thinking stays with it"),
  "agent.content": part(["file", "source-url"]),
  "tool.called": part(toolParts, "its start is `meta.stepTimes`; a subagent's call is its window's"),
  "tool.progress": part(toolParts, "the call's output so far"),
  "tool.completed": part(toolParts, "its end is `meta.stepTimes`"),
  "tool.failed": part(toolParts, "its end is `meta.stepTimes`"),
  "approval.requested": part(toolParts, "the call's approval"),
  "approval.answered": part(toolParts, "the approval's receipt"),
  "approval.auto_answered": part(toolParts, "the approval's receipt"),
  "approval.closed": part(toolParts, "the approval's receipt"),
  "question.asked": part(["data-question"]),
  "question.answered": part(["data-question"]),
  "question.closed": part(["data-question"]),
  "plan.updated": part(["data-plan"], "a subagent's plan is its own"),
  "compaction.updated": part(["data-compaction"]),
  "session.config_changed": eventLog("bookkeeping (milestone 10): the effort divider and the plan markers say what a reader needs"),
  "driver.changed": part(["data-driver"]),
  "runner.connected": eventLog("bookkeeping (milestone 10)"),
  "runner.lost": part(["data-system"], "a failure line"),
  "session.restored": part(["data-system"], "a divider"),
  "session.crashed": part(["data-system"], "a failure line"),
  "pr.opened": part(["data-pr"], "a result of the session's last turn (milestone 10), and the `firstPr` of the push it opened"),
  "agent.unknown": part(["data-unsupported"]),
  "environment.setup_started": part(["data-setup"]),
  "environment.setup_output": part(["data-setup"]),
  "environment.setup_finished": part(["data-setup"]),
  "git.pushed": part(["data-pushed"], "a task branch's: a result of the session's last turn (milestone 10); the hidden ref's is the Event log's, its commit the turn's `meta.saved.hiddenRefs`"),
  "pr.text_set": part(["data-pr-text"], "a result of the session's last turn (milestone 10)"),
  "session.ended": turn("ended", "on the session's last turn (milestone 10); with no turn, the Event log's"),
  "usage.recorded": turn("usage"),
  "session.usage": turn("context", "the context meter only (Q124)"),
  "provider.rate_limited": eventLog("the server holds new dispatches on the provider"),
  // Protocol minor 1.
  "session.saved": turn("saved", "the turn it follows (milestone 10); with no turn, the Event log's"),
  "session.limit_reached": part(["data-limit"]),
  "ticket.files_ready": part(["data-ticket-files"]),
  "workspace.files_outside_repos": part(["data-files-outside"]),
  // Protocol minor 2: the panel reads them from `tasks.get` (milestone 3).
  "plan.proposed": eventLog("the plan's block reads `tasks.get` (milestone 3)"),
  "plan.answered": eventLog("the plan's block reads `tasks.get` (milestone 3)"),
  "check.started": eventLog("the Checks tab; their counts are the turn's `meta.saved.checks`"),
  "check.finished": eventLog("the Checks tab; their counts are the turn's `meta.saved.checks`"),
  "snapshot.built": eventLog("the environment's page (milestone 3)"),
  "snapshot.failed": eventLog("the environment's page (milestone 3)"),
  "service.healthy": eventLog("milestone 3"),
  "service.failed": eventLog("milestone 3"),
  "diff.comments_sent": eventLog("the comments' message is the member's own (F-072)"),
  "ticket.closed": eventLog("milestone 3"),
  "pr.comment_received": part(["data-pr-comment"], "F-111"),
  // Protocol minor 3.
  "memory.used": eventLog("milestone 4"),
  "memory.proposed": part(["data-memory-proposed"], "a result of the session's last turn (milestone 10)"),
  "turn.held": part(["data-held"], "F-037"),
  "turn.released": part(["data-released"], "F-037"),
  "review.check_updated": eventLog("milestone 4"),
  "pr.related_updated": eventLog("milestone 4"),
  "effort.changed": part(["data-effort"]),
  // Protocol minor 4.
  "box.waiting": eventLog("milestone 5"),
  "box.scheduled": eventLog("milestone 5"),
  "task.cancelled": eventLog("milestone 5"),
  "runner.drained": eventLog("milestone 5"),
  "runner.resumed": eventLog("milestone 5"),
  // Protocol minor 5: milestone 6's task page reads most from `tasks.get`.
  "question.auto_answered": eventLog("milestone 6"),
  "commit.filtered": eventLog("milestone 6"),
  "automation.started": eventLog("milestone 6"),
  "task.approval_requested": eventLog("milestone 6"),
  "task.approved": eventLog("milestone 6"),
  "task.rejected": eventLog("milestone 6"),
  "tracker.session_event": eventLog("milestone 6"),
  "draft.submitted": part(["data-draft"], "a result of the session's last turn (milestone 10)"),
  "draft.applied": eventLog("milestone 6"),
  "ci.updated": eventLog("the PR's CI line reads `tasks.get` (milestone 6)"),
  "round.started": eventLog("the round's message is ostra's own (milestone 6)"),
  "round.capped": eventLog("the round limit's block reads `tasks.get` (milestone 6)"),
  "review.submitted": part(["data-review"], "in a review task (`taskKind`), a result of the turn that handed it in (milestone 10); a repeat is its own, `repeat: true`; the code task's copy of the first hand-in, made by none of its turns, is the Event log's"),
  "review.posted": part(["data-review"], "its hand-in's `posted` in a review task (milestone 10); the code task's copy, whose hand-in joined no turn, is the Event log's"),
  "reviewers.updated": eventLog("milestone 6"),
  "environment.proposed": eventLog("milestone 6"),
  // Protocol minor 6 (F-138): the turn's subagents, drawn as its badge and window.
  "subagent.started": turn("subagents"),
  "subagent.status": turn("subagents"),
  // Protocol minor 7 (milestone 8, ADR 0068): the app and its pictures; the previews are the pane's.
  "app.process": part(["data-app-process"], "F-140"),
  "app.browser": part(["data-no-browser"], "once per task, when the box has no browser (F-121); one with a browser is the Event log's"),
  "attachment.added": part(["data-attachments"], "at its place in the turn (F-121)"),
  "attachment.skipped": part(["data-attachment-skipped"], "F-121"),
  "preview.list": eventLog("the preview pane (milestone 8)"),
  "preview.dropped": eventLog("the preview pane (milestone 8)"),
  "preview.opened": eventLog("the preview pane (milestone 8)"),
  "preview.closed": eventLog("the preview pane (milestone 8)"),
  "preview.level_changed": eventLog("the preview pane (milestone 8)"),
  "preview.link_created": eventLog("the preview pane (milestone 8)"),
  "preview.link_revoked": eventLog("the preview pane (milestone 8)"),
  "app.started_by": eventLog("the preview pane (milestone 8)"),
  // Protocol minor 8 (milestone 9, ADR 0070).
  "files.written": part(["data-message-files"], "the files of the messages it wrote them for"),
  // A pool runner's lost box (F-047) is a runner event core turns into `session.crashed`: never stored.
  "box.lost": eventLog("core records the session's crash"),
  "ticket.context_read": eventLog("\"What the agent got\" reads `tasks.ticketContext` (milestone 9)"),
} as const satisfies Record<TaskEventKind, FoldPlace>;
