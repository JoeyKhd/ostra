import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  blobIdSchema,
  clientMessageIdSchema,
  memberIdSchema,
  repoIdSchema,
  sessionIdSchema,
  segmentIdSchema,
  storedEventSchema,
  turnIdSchema,
  taskEventKinds,
} from "@ostra/protocol";
import type { StoredEvent, TaskEvent, TaskEventKind } from "@ostra/protocol";
import { eventFixtures, fixtureDigests, fixtureIds, minor8EventFixtures } from "@ostra/protocol/testing";

import { foldCoverage } from "./coverage.ts";
import { deriveTaskState } from "./derive-state.ts";
import { deepEqual, foldTaskEvents, pullRequestsOf } from "./fold.ts";
import { applyLiveTextFrame, emptyLiveText, pruneLiveText, visibleLiveText } from "./live-text.ts";
import type { LiveText } from "./live-text.ts";
import {
  allKindsSession,
  longSession,
  recordedOpenCodeSession,
  storeEvents,
} from "./testing/index.ts";
import type { TaskUIMessage, TaskUIPart } from "./ui-types.ts";

const partsOf = (messages: readonly TaskUIMessage[]): TaskUIPart[] =>
  messages.flatMap((m) => m.parts);
const typesOf = (messages: readonly TaskUIMessage[]): Set<string> =>
  new Set(partsOf(messages).map((p) => p.type));
const f = eventFixtures;

describe("foldCoverage", () => {
  it("names every event kind of the protocol", () => {
    expect(Object.keys(foldCoverage).sort()).toEqual([...taskEventKinds].sort());
  });
});

// What each kind must leave in the thread, given the prefix a real session would have before it.
const turnPrefix: TaskEvent[] = [f["turn.started"]];
const toolPrefix: TaskEvent[] = [...turnPrefix, f["tool.called"]];
const approvalPrefix: TaskEvent[] = [...toolPrefix, f["approval.requested"]];
const questionPrefix: TaskEvent[] = [...turnPrefix, f["question.asked"]];

type KindCase = {
  readonly prefix: readonly TaskEvent[];
  readonly check: (messages: TaskUIMessage[]) => void;
  /** The fold's options, for a kind that lands only in some tasks (a review task's hand-in). */
  readonly options?: Parameters<typeof foldTaskEvents>[2];
};

const findPart = (messages: readonly TaskUIMessage[], type: string): TaskUIPart | undefined =>
  partsOf(messages).find((p) => p.type === type);

const toolEdit = (messages: readonly TaskUIMessage[]) => {
  const part = findPart(messages, "tool-edit");
  if (part?.type !== "tool-edit") throw new Error("no edit part");
  return part;
};

const lastTurn = (messages: readonly TaskUIMessage[]) => messages.filter((m) => m.role === "assistant").at(-1);
const lastTurnMeta = (messages: readonly TaskUIMessage[]) => lastTurn(messages)?.metadata;

const kindCases: Readonly<Record<TaskEventKind, KindCase>> = {
  "user.message": {
    prefix: [],
    check: (m) => {
      expect(m[0]?.role).toBe("user");
      expect(m[0]?.metadata?.author?.memberId).toBe(fixtureIds.member);
    },
  },
  "turn.started": {
    prefix: [],
    check: (m) => {
      expect(m[0]?.metadata?.turnState).toBe("running");
    },
  },
  "turn.ended": {
    prefix: turnPrefix,
    check: (m) => {
      expect(m[0]?.metadata?.stopReason).toBe("end_turn");
    },
  },
  "turn.failed": {
    prefix: turnPrefix,
    check: (m) => {
      expect(m[0]?.metadata?.error).toContain("500");
    },
  },
  "turn.cancel_requested": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "agent.message": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("text");
    },
  },
  "agent.thought": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("reasoning");
    },
  },
  "agent.content": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("source-url");
    },
  },
  "tool.called": {
    prefix: turnPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("input-available");
    },
  },
  "tool.progress": {
    // An edit's progress doesn't fit its output schema: the call stays running, nothing breaks.
    prefix: toolPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("input-available");
    },
  },
  "tool.completed": {
    prefix: toolPrefix,
    check: (m) => {
      const part = toolEdit(m);
      expect(part.state).toBe("output-available");
      if (part.state === "output-available") expect(part.output.files[0]?.added).toBe(12);
    },
  },
  "tool.failed": {
    prefix: toolPrefix,
    check: (m) => {
      const part = toolEdit(m);
      expect(part.state).toBe("output-error");
      if (part.state === "output-error") expect(part.errorText).toBe("permission denied");
    },
  },
  "approval.requested": {
    prefix: toolPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("approval-requested");
    },
  },
  "approval.answered": {
    prefix: approvalPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("approval-responded");
    },
  },
  "approval.auto_answered": {
    prefix: approvalPrefix,
    check: (m) => {
      const part = toolEdit(m);
      expect(part.state).toBe("approval-responded");
      expect(part.approval?.isAutomatic).toBe(true);
    },
  },
  "approval.closed": {
    prefix: approvalPrefix,
    check: (m) => {
      expect(toolEdit(m).state).toBe("output-error");
    },
  },
  "question.asked": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-question");
    },
  },
  "question.answered": {
    prefix: questionPrefix,
    check: (m) => {
      const part = findPart(m, "data-question");
      expect(part?.type === "data-question" ? part.data.status.state : undefined).toBe("answered");
    },
  },
  "question.closed": {
    prefix: questionPrefix,
    check: (m) => {
      const part = findPart(m, "data-question");
      expect(part?.type === "data-question" ? part.data.status.state : undefined).toBe("closed");
    },
  },
  "plan.updated": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-plan");
    },
  },
  "compaction.updated": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-compaction");
    },
  },
  "session.config_changed": {
    // Milestone 10 (F-151): bookkeeping, in the Event log only; it was a system row.
    prefix: [],
    check: (m) => {
      expect(m).toEqual([]);
    },
  },
  "driver.changed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-driver");
    },
  },
  "runner.connected": {
    // Milestone 10 (F-151): bookkeeping, in the Event log only; it was a system row.
    prefix: [],
    check: (m) => {
      expect(m).toEqual([]);
    },
  },
  "runner.lost": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "session.restored": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "session.crashed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-system");
    },
  },
  "session.saved": {
    // Milestone 10 (F-151): the turn's `meta.saved`; it was a row of its own (ticket 36).
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.saved).toEqual({ archiveBytes: 48_213, hiddenRefs: [fixtureDigests.hiddenRefSha], unsaved: 0, checks: null });
      expect(typesOf(m)).not.toContain("data-saved");
      expect(typesOf(m)).not.toContain("data-unsupported");
    },
  },
  "session.limit_reached": {
    prefix: [],
    check: (m) => {
      // Ticket 36: protocol minor 1's markers have rows of their own.
      expect(typesOf(m)).toContain("data-limit");
      expect(typesOf(m)).not.toContain("data-unsupported");
    },
  },
  "ticket.files_ready": {
    prefix: [],
    check: (m) => {
      // Ticket 36: protocol minor 1's markers have rows of their own.
      expect(typesOf(m)).toContain("data-ticket-files");
      expect(typesOf(m)).not.toContain("data-unsupported");
    },
  },
  "workspace.files_outside_repos": {
    prefix: [],
    check: (m) => {
      const part = m.flatMap((message) => message.parts).find((each) => each.type === "data-files-outside");
      expect(part?.type === "data-files-outside" ? part.data : undefined).toEqual({ paths: ["notes.md", "plan.txt"], more: 0 });
    },
  },
  "plan.proposed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "plan.answered": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "check.started": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "check.finished": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "snapshot.built": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "snapshot.failed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "service.healthy": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "service.failed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "diff.comments_sent": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "ticket.closed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "pr.comment_received": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-pr-comment");
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "memory.used": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "memory.proposed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-memory-proposed");
      expect(m.at(-1)?.parts.find((part) => part.type === "data-memory-proposed")).toMatchObject({ data: { proposalId: f["memory.proposed"].proposalId, title: f["memory.proposed"].title } });
    },
  },
  "turn.held": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-held");
    },
  },
  "turn.released": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-released");
    },
  },
  "review.check_updated": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "pr.related_updated": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "effort.changed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-effort");
    },
  },
  "box.waiting": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "box.scheduled": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "task.cancelled": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "runner.drained": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "runner.resumed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "question.auto_answered": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "commit.filtered": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "automation.started": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "task.approval_requested": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "task.approved": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "task.rejected": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "tracker.session_event": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "draft.submitted": {
    // Milestone 10 (F-151): a result of the turn that handed it in; it drew nothing before.
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurn(m)?.parts.find((part) => part.type === "data-draft")).toMatchObject({ data: { draftId: fixtureIds.draft, version: 1, acceptanceCriteria: null, subTickets: null } });
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "draft.applied": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "ci.updated": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "round.started": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "round.capped": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "review.submitted": {
    // Milestone 10 (F-151): in a review task, a result of the turn that handed it in; it drew nothing before.
    prefix: turnPrefix,
    options: { taskKind: "review" },
    check: (m) => {
      expect(lastTurn(m)?.parts.find((part) => part.type === "data-review")).toMatchObject({ data: { reviewRunId: fixtureIds.reviewRun, blocking: 1, nits: 2, repeat: false, posted: [] } });
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "review.posted": {
    // Milestone 10 (F-151): its hand-in's result says where it was posted; it drew nothing before.
    prefix: [...turnPrefix, f["review.submitted"]],
    options: { taskKind: "review" },
    check: (m) => {
      expect(lastTurn(m)?.parts.find((part) => part.type === "data-review")).toMatchObject({ data: { posted: [{ repoId: fixtureIds.repo, prNumber: 7, url: f["review.posted"].url }] } });
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "reviewers.updated": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "environment.proposed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  // F-138: the turn's subagent tree, in the turn's metadata; nothing in the thread.
  "subagent.started": {
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.subagents?.nodes.map((node) => [node.id, node.type, node.description])).toEqual([[fixtureIds.subagent, "general", "inspect readme"]]);
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "subagent.status": {
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.subagents?.nodes.map((node) => [node.id, node.state, node.error])).toEqual([[fixtureIds.subagent, "failed", "the model endpoint returned 500"]]);
    },
  },
  // Protocol minor 7 (milestone 8): no row until tickets 17 and 21 draw them.
  "app.process": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-app-process");
    },
  },
  "app.browser": {
    prefix: [],
    check: (m) => {
      // A box with a browser says nothing; one without says so once (attachments.test.ts).
      expect(typesOf(m)).not.toContain("data-no-browser");
    },
  },
  "attachment.added": {
    prefix: turnPrefix,
    check: (m) => {
      expect(findPart(m, "data-attachments")).toBeDefined();
    },
  },
  "attachment.skipped": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).toContain("data-attachment-skipped");
    },
  },
  "preview.list": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "preview.dropped": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "preview.opened": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "preview.closed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "preview.level_changed": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "preview.link_created": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "preview.link_revoked": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "app.started_by": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "files.written": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "box.lost": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "ticket.context_read": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "egress.blocked": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
    },
  },
  "pr.opened": {
    prefix: [f["pr.text_set"]],
    check: (m) => {
      const part = findPart(m, "data-pr");
      expect(part?.type === "data-pr" ? part.data.title : undefined).toBe("Add CONTRIBUTING.md");
    },
  },
  "agent.unknown": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-unsupported");
    },
  },
  "environment.setup_started": {
    prefix: [],
    check: (m) => {
      const part = findPart(m, "data-setup");
      expect(part?.type === "data-setup" ? part.data.state : undefined).toBe("running");
    },
  },
  "environment.setup_output": {
    prefix: [f["environment.setup_started"]],
    check: (m) => {
      const part = findPart(m, "data-setup");
      expect(part?.type === "data-setup" ? part.data.output : undefined).toEqual([
        { stream: "stdout", text: "Installing...\n" },
      ]);
    },
  },
  "environment.setup_finished": {
    prefix: [f["environment.setup_started"]],
    check: (m) => {
      const part = findPart(m, "data-setup");
      expect(part?.type === "data-setup" ? part.data.state : undefined).toBe("succeeded");
      expect(m).toHaveLength(1);
    },
  },
  "git.pushed": {
    prefix: [],
    check: (m) => {
      const part = findPart(m, "data-pushed");
      expect(part?.type === "data-pushed" ? part.data.hidden : undefined).toBe(false);
    },
  },
  "pr.text_set": {
    prefix: [],
    check: (m) => {
      expect(typesOf(m)).toContain("data-pr-text");
    },
  },
  "session.ended": {
    // Milestone 10 (F-151): the session's last turn's `meta.ended`; it was a row of its own.
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.ended).toEqual({ outcome: "with-changes", repos: [{ repoId: fixtureIds.repo, ahead: true }] });
      expect(typesOf(m)).not.toContain("data-session-end");
    },
  },
  "usage.recorded": {
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300 });
    },
  },
  "session.usage": {
    prefix: turnPrefix,
    check: (m) => {
      expect(lastTurnMeta(m)?.context).toEqual({ used: 12_000, size: 200_000 });
    },
  },
  // The server acts on it (it holds new dispatches on the provider); the thread shows nothing.
  "provider.rate_limited": {
    prefix: turnPrefix,
    check: (m) => {
      expect(typesOf(m)).not.toContain("data-system");
      expect(typesOf(m)).not.toContain("data-unsupported");
    },
  },
};

describe("foldTaskEvents, one kind at a time", () => {
  for (const kind of taskEventKinds) {
    it(`folds ${kind} (protocol fixture)`, () => {
      const cases: Readonly<Record<TaskEventKind, KindCase>> = kindCases;
      const { prefix, check, options } = cases[kind];
      const messages = foldTaskEvents(storeEvents([...prefix, f[kind]]), [], options);
      expect(typesOf(messages)).not.toContain("data-problem");
      check(messages);
    });
  }
});

describe("where each kind lands (F-151)", () => {
  // The kinds whose protocol fixture takes a branch that draws nothing, with an event that draws.
  const drawing: Partial<Record<TaskEventKind, { readonly prefix: readonly TaskEvent[]; readonly event: TaskEvent }>> = {
    // An edit's progress doesn't fit its output; a command's does.
    "tool.progress": {
      prefix: [...turnPrefix, { kind: "tool.called", turnId: fixtureIds.turn, toolCallId: fixtureIds.toolCall, toolKind: "execute", title: "pnpm test", input: { command: "pnpm test" } }],
      event: { kind: "tool.progress", toolCallId: fixtureIds.toolCall, output: { output: "running", truncated: false, exitCode: null } },
    },
    // A box with a browser says nothing; one without says so.
    "app.browser": { prefix: [], event: { kind: "app.browser", browser: { available: false, reason: "not-in-image" } } },
    // The runner's writes land on the message whose files they are: one it couldn't write is named.
    "files.written": {
      prefix: [minor8EventFixtures.withFiles],
      event: { ...f["files.written"], files: [{ fileId: fixtureIds.imageFile, textWritten: false }], skipped: [{ fileId: fixtureIds.documentFile, reason: "digest-mismatch" }] },
    },
  };
  const cases: Readonly<Record<TaskEventKind, KindCase>> = kindCases;

  /** Why a kind isn't where `foldCoverage` places it, or `null` when it is. */
  const misplaced = (kind: TaskEventKind): string | null => {
    const { prefix, event } = drawing[kind] ?? { prefix: cases[kind].prefix, event: f[kind] };
    const { options } = cases[kind];
    const without = foldTaskEvents(storeEvents(prefix), [], options);
    const withIt = foldTaskEvents(storeEvents([...prefix, event]), [], options);
    const place = foldCoverage[kind];
    switch (place.in) {
      case "message": {
        const before = new Set(without.map((message) => message.id));
        return withIt.some((message) => message.role === place.role && !before.has(message.id)) ? null : `no new ${place.role} message`;
      }
      case "part": {
        const types: readonly string[] = place.parts;
        const fresh = partsOf(withIt).filter((each) => types.includes(each.type) && !partsOf(without).some((old) => deepEqual(old, each)));
        return fresh.length > 0 ? null : `no new or changed ${place.parts.join(" or ")} part`;
      }
      case "turn": {
        const now = lastTurnMeta(withIt)?.[place.field];
        return now !== undefined && !deepEqual(now, lastTurnMeta(without)?.[place.field]) ? null : `the turn's ${place.field} didn't change`;
      }
      case "event-log":
        return deepEqual(withIt, without) ? null : "it changed the thread";
      default:
        return place satisfies never;
    }
  };

  it("F-151/c1: every event kind lands where foldCoverage places it: a message, a part, a field of its turn, or the Event log only", () => {
    const wrong = taskEventKinds.flatMap((kind) => {
      const why = misplaced(kind);
      return why === null ? [] : [`${kind}: ${why}`];
    });
    expect(wrong).toEqual([]);
  });
});

describe("foldTaskEvents, a session with every kind", () => {
  const messages = foldTaskEvents(storeEvents(allKindsSession()), []);

  it("shows no problem row for a coherent session", () => {
    expect(partsOf(messages).filter((p) => p.type === "data-problem")).toEqual([]);
  });

  it("settles the approvals of the second turn as receipts", () => {
    const execs = partsOf(messages).flatMap((p) => (p.type === "tool-execute" ? [p] : []));
    expect(execs.find((p) => p.title === "ls")?.state).toBe("output-available");
    expect(execs.find((p) => p.title === "rm -rf build")?.state).toBe("output-error");
    expect(execs.find((p) => p.title === "pnpm test")?.state).toBe("output-error");
  });

  it("keeps object identity for messages that didn't change", () => {
    const again = foldTaskEvents(storeEvents(allKindsSession()), [], { previous: messages });
    again.forEach((message, i) => {
      expect(message).toBe(messages[i]);
    });
  });

  it("gives a changed message a new object and keeps the others", () => {
    const events = allKindsSession();
    // Milestone 10 (F-151): a driver change, since a config change is no row any more.
    const extra: TaskEvent = f["driver.changed"];
    const again = foldTaskEvents(storeEvents([...events, extra]), [], { previous: messages });
    expect(again.slice(0, messages.length).every((m, i) => m === messages[i])).toBe(true);
    expect(again).toHaveLength(messages.length + 1);
  });

  it("lists the pull requests", () => {
    expect(pullRequestsOf(messages).map((pr) => pr.number)).toEqual([1]);
  });
});

describe("foldTaskEvents, the read side", () => {
  it("shows a kind this build doesn't know as an unsupported row", () => {
    const future = storedEventSchema.parse({
      taskId: fixtureIds.task,
      seq: 1,
      sessionId: fixtureIds.session,
      sessionSeq: 1,
      at: 1,
      event: { kind: "agent.from_the_future", x: 1 },
    });
    const part = foldTaskEvents([future], [])[0]?.parts[0];
    expect(part?.type).toBe("data-unsupported");
    expect(part?.type === "data-unsupported" ? part.data : undefined).toEqual({
      seq: 1,
      rawKind: "agent.from_the_future",
      acp: false,
    });
  });

  it("marks a tool update for an unknown call as a problem row, not a crash", () => {
    const messages = foldTaskEvents(storeEvents([f["tool.completed"]]), []);
    expect(typesOf(messages)).toContain("data-problem");
  });

  it("F-151/c1: draws no part for the hidden ref's push: its commit is the turn's saved work", () => {
    // Milestone 10: it was a `data-pushed` row marked hidden.
    const hidden: TaskEvent = { ...f["git.pushed"], ref: `refs/ostra/wip/${fixtureIds.task}` };
    expect(foldTaskEvents(storeEvents([hidden]), [])).toEqual([]);
    const after = foldTaskEvents(storeEvents([f["turn.started"], f["turn.ended"], hidden]), []);
    expect(typesOf(after)).not.toContain("data-pushed");
  });
});

describe("partial text", () => {
  const live = (segmentId: string, text = "partial"): LiveText => ({
    sessionId: fixtureIds.session,
    turnId: fixtureIds.turn,
    segmentId: segmentIdSchema.parse(segmentId),
    kind: "message",
    text,
    awaitingSnapshot: false,
  });
  const streaming = (messages: readonly TaskUIMessage[]) =>
    partsOf(messages).filter((p) => p.type === "text" && p.state === "streaming");

  it("is shown in its turn until the completed message arrives", () => {
    const started = storeEvents([f["turn.started"]]);
    expect(streaming(foldTaskEvents(started, [live("seg-1")]))).toHaveLength(1);
    const done = storeEvents([f["turn.started"], f["agent.message"]]);
    expect(streaming(foldTaskEvents(done, [live("seg-1")]))).toEqual([]);
    expect(streaming(foldTaskEvents(done, [live("seg-other")]))).toHaveLength(1);
  });

  it("opens a turn that has no committed event yet", () => {
    const messages = foldTaskEvents([], [live("seg-1", "Hel")]);
    expect(messages[0]?.metadata?.turnState).toBe("running");
    expect(streaming(messages)).toHaveLength(1);
  });

  const frame = (offset: number, text: string) => ({
    taskId: fixtureIds.task,
    sessionId: fixtureIds.session,
    turnId: fixtureIds.turn,
    segmentId: segmentIdSchema.parse("seg-1"),
    kind: "message" as const,
    offset,
    text,
  });

  it("applies a snapshot, then deltas at the right offset", () => {
    let state = applyLiveTextFrame(emptyLiveText, frame(0, "Hel"));
    state = applyLiveTextFrame(state, frame(3, "lo"));
    expect(visibleLiveText(state).map((l) => l.text)).toEqual(["Hello"]);
  });

  it("drops a delta at the wrong offset and waits for the next snapshot", () => {
    let state = applyLiveTextFrame(emptyLiveText, frame(0, "Hel"));
    state = applyLiveTextFrame(state, frame(9, "zzz"));
    state = applyLiveTextFrame(state, frame(3, "lo"));
    expect(visibleLiveText(state).map((l) => l.text)).toEqual(["Hel"]);
    state = applyLiveTextFrame(state, frame(0, "Hello, world"));
    expect(visibleLiveText(state).map((l) => l.text)).toEqual(["Hello, world"]);
  });

  it("ignores a delta for a segment it has no snapshot of", () => {
    const state = applyLiveTextFrame(emptyLiveText, frame(4, "late"));
    expect(visibleLiveText(state)).toEqual([]);
    expect(applyLiveTextFrame(state, frame(8, "more"))).toBe(state);
  });

  it("is pruned when its message is committed or its turn ends", () => {
    const state = applyLiveTextFrame(emptyLiveText, frame(0, "Hel"));
    expect(pruneLiveText(state, storeEvents([f["agent.message"]])).size).toBe(0);
    expect(pruneLiveText(state, storeEvents([f["turn.ended"]])).size).toBe(0);
    expect(pruneLiveText(state, storeEvents([f["runner.lost"]]))).toBe(state);
  });
});

describe("optimistic messages", () => {
  const optimistic = [
    {
      clientMessageId: clientMessageIdSchema.parse("client-msg-1"),
      memberId: memberIdSchema.parse(fixtureIds.member),
      text: "Add a CONTRIBUTING.md",
      delivery: "immediate" as const,
    },
  ];

  it("shows the driver's message at once and replaces it with the committed one (same id)", () => {
    const before = foldTaskEvents([], [], { optimistic });
    expect(before[0]?.id).toBe("user:client-msg-1");
    expect(before[0]?.metadata?.optimistic).toBe(true);
    const after = foldTaskEvents(storeEvents([f["user.message"]]), [], { optimistic });
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe("user:client-msg-1");
    expect(after[0]?.metadata?.optimistic).toBeUndefined();
  });
});

describe("a recorded OpenCode session", () => {
  const events: StoredEvent[] = recordedOpenCodeSession.map((raw) => storedEventSchema.parse(raw));
  const messages = foldTaskEvents(events, []);
  const parts = partsOf(messages);
  const count = (kind: TaskEventKind) => events.filter((e) => e.event.kind === kind).length;

  it("folds with no problem row", () => {
    expect(parts.filter((p) => p.type === "data-problem")).toEqual([]);
  });

  it("drops nothing: every call, message and thought has its part", () => {
    const toolParts = parts.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool");
    expect(toolParts).toHaveLength(count("tool.called"));
    expect(parts.filter((p) => p.type === "text")).toHaveLength(
      count("agent.message") + count("user.message"),
    );
    expect(parts.filter((p) => p.type === "reasoning")).toHaveLength(count("agent.thought"));
    expect(parts.filter((p) => p.type === "data-unsupported")).toHaveLength(count("agent.unknown"));
    for (const type of [
      "tool-read",
      "tool-edit",
      "tool-execute",
      "dynamic-tool",
      "data-plan",
      "data-setup",
      "data-pushed",
      "data-pr",
      "data-pr-text",
      "data-compaction",
    ]) {
      expect(typesOf(messages)).toContain(type);
    }
    // Milestone 10 (F-151): the session's end is its last turn's fact, and the runner's connection
    // the Event log's; they were the `data-session-end` and `data-system` rows.
    expect(lastTurnMeta(messages)?.ended?.outcome).toBe("with-changes");
    expect(typesOf(messages)).not.toContain("data-session-end");
    expect(typesOf(messages)).not.toContain("data-system");
  });

  it("renders a read that failed as an error, and the edit with its counts", () => {
    const reads = parts.flatMap((p) => (p.type === "tool-read" ? [p] : []));
    expect(reads.map((p) => p.state)).toContain("output-error");
    const edit = parts.find((p) => p.type === "tool-edit");
    expect(
      edit?.type === "tool-edit" && edit.state === "output-available"
        ? edit.output.files[0]
        : undefined,
    ).toMatchObject({ path: "README.md", added: 1, removed: 1 });
  });

  it("derives what the agent is doing, the tokens and the PR", () => {
    const state = deriveTaskState(events);
    expect(state.activity).toEqual({ kind: "session-ended", outcome: "with-changes" });
    expect(state.turnRunning).toBe(false);
    expect(state.tokens.inputTokens).toBe(43_284);
    expect(state.pullRequests.map((pr) => pr.url)).toEqual([
      "https://github.com/ostra-test/test1/pull/7",
    ]);
    expect(state.branches).toHaveLength(1);
    expect(state.headSeq).toBe(events.length);
  });

  it("derives a running tool part-way through", () => {
    const upTo = events.findIndex((e) => e.event.kind === "tool.progress");
    const state = deriveTaskState(events.slice(0, upTo + 1));
    expect(state.activity).toMatchObject({ kind: "tool", toolKind: "execute" });
    expect(state.turnRunning).toBe(true);
  });
});

describe("milestone 3's marks in the thread", () => {
  it("F-051: the setup line says whether the host's dependency cache was warm", () => {
    const setupOf = (messages: readonly TaskUIMessage[]) => partsOf(messages).find((part) => part.type === "data-setup");
    const warm = foldTaskEvents(storeEvents([f["environment.setup_started"], { ...f["environment.setup_finished"], dependencyCache: "warm" }]), []);
    const cold = foldTaskEvents(storeEvents([f["environment.setup_started"], { ...f["environment.setup_finished"], dependencyCache: "cold" }]), []);
    const none = foldTaskEvents(storeEvents([f["environment.setup_started"], f["environment.setup_finished"]]), []);
    expect(setupOf(warm)).toMatchObject({ data: { dependencyCache: "warm" } });
    expect(setupOf(cold)).toMatchObject({ data: { dependencyCache: "cold" } });
    expect(setupOf(none)?.type === "data-setup" ? setupOf(none)?.data : null).not.toHaveProperty("dependencyCache");
  });

  it("F-063, F-072: a plan turn is marked, and a message ostra sent for the member carries why", () => {
    const planTurn = { ...f["turn.started"], mode: "plan" as const };
    const planned = foldTaskEvents(storeEvents([planTurn]), []);
    expect(planned.find((message) => message.role === "assistant")?.metadata?.turnMode).toBe("plan");
    const built = foldTaskEvents(storeEvents([f["turn.started"]]), []);
    expect(built.find((message) => message.role === "assistant")?.metadata?.turnMode).toBeUndefined();
    const comments = foldTaskEvents(storeEvents([{ ...f["user.message"], intent: "diff-comments" as const }]), []);
    expect(comments.find((message) => message.role === "user")?.metadata?.author?.intent).toBe("diff-comments");
    const typed = foldTaskEvents(storeEvents([f["user.message"]]), []);
    expect(typed.find((message) => message.role === "user")?.metadata?.author?.intent).toBeUndefined();
  });
});

describe("reasoning effort in the thread (F-137)", () => {
  const otherTurn = turnIdSchema.parse("01900000-0000-7000-8000-0000000000b2");
  const effortOf = (messages: readonly TaskUIMessage[]) => partsOf(messages).find((part) => part.type === "data-effort");

  it("F-137/c8: a turn keeps the level it ran at, the level asked for when clamped, and its reasoning tokens", () => {
    const clamped = foldTaskEvents(storeEvents([
      { ...f["turn.started"], effort: "max", adjustedFrom: "xhigh" },
      { ...f["usage.recorded"], outputTokens: 9_100, reasoningTokens: 6_400 },
      { ...f["usage.recorded"], outputTokens: 100, reasoningTokens: 100 },
      f["turn.ended"],
    ]), []);
    const meta = lastTurnMeta(clamped);
    expect(meta?.effort).toBe("max");
    expect(meta?.adjustedFrom).toBe("xhigh");
    expect(meta?.usage?.reasoningTokens).toBe(6_500);
    expect(meta?.usage?.outputTokens).toBe(9_200);
  });

  it("F-137: a turn at the default, or with no reasoning reported, carries neither", () => {
    const plain = foldTaskEvents(storeEvents([{ ...f["turn.started"], effort: "default" }, f["usage.recorded"], f["turn.ended"]]), []);
    const meta = lastTurnMeta(plain);
    expect(meta?.effort).toBeUndefined();
    expect(meta?.adjustedFrom).toBeUndefined();
    expect(meta?.usage).not.toHaveProperty("reasoningTokens");
  });

  it("F-137/c8: a change during a turn applies from the next turn, between turns it doesn't say so, and it sits in time order", () => {
    const during = foldTaskEvents(storeEvents([f["turn.started"], f["agent.message"], { ...f["effort.changed"], from: "xhigh", to: "low" }]), []);
    expect(effortOf(during)).toMatchObject({ data: { from: "xhigh", to: "low", memberId: fixtureIds.member, duringTurn: true } });
    expect(during.map((message) => message.role)).toEqual(["assistant", "system"]);
    const between = foldTaskEvents(storeEvents([f["turn.started"], f["turn.ended"], { ...f["effort.changed"], to: "low" }, { ...f["turn.started"], turnId: otherTurn }]), []);
    expect(effortOf(between)).toMatchObject({ data: { to: "low", duringTurn: false } });
    expect(between.map((message) => message.role)).toEqual(["assistant", "system", "assistant"]);
  });

  it("F-137/c11: the state follows the task's level, the running turn's level and the reasoning tokens", () => {
    const events = storeEvents([
      { ...f["turn.started"], effort: "max", adjustedFrom: "xhigh" },
      { ...f["usage.recorded"], reasoningTokens: 6_400 },
      { ...f["effort.changed"], from: "xhigh", to: "low" },
    ]);
    const running = deriveTaskState(events);
    expect(running.effort).toBe("low");
    expect(running.runningEffort).toBe("max");
    expect(running.reasoningTokens).toBe(6_400);
    const ended = deriveTaskState([...events, ...storeEvents([f["turn.ended"]], { fromSeq: 10 })]);
    expect(ended.runningEffort).toBeNull();
    expect(deriveTaskState(storeEvents([f["turn.started"]])).runningEffort).toBe("default");
    expect(deriveTaskState([]).effort).toBeNull();
  });
});

describe("deriveTaskState", () => {
  it("is idle with no events, setting up during setup, and waits on an approval", () => {
    expect(deriveTaskState([]).activity).toEqual({ kind: "idle" });
    expect(deriveTaskState(storeEvents([f["environment.setup_started"]])).activity).toEqual({
      kind: "setting-up",
    });
    const failed: TaskEvent = { ...f["environment.setup_finished"], exitCode: 2 };
    expect(deriveTaskState(storeEvents([failed])).activity).toEqual({
      kind: "setup-failed",
      exitCode: 2,
    });
    const waiting = deriveTaskState(storeEvents(approvalPrefix));
    expect(waiting.activity).toEqual({ kind: "waiting-approval" });
    expect(waiting.pendingApprovalIds).toEqual([fixtureIds.approval]);
  });

  it("follows the driver and a stop request", () => {
    const state = deriveTaskState(
      storeEvents([f["turn.started"], f["driver.changed"], f["turn.cancel_requested"]]),
      {
        initialDriver: fixtureIds.member,
      },
    );
    expect(state.driverMemberId).toBe(fixtureIds.otherMember);
    expect(state.activity).toEqual({ kind: "stopping" });
  });

  it("shows a crash and a lost runner", () => {
    expect(deriveTaskState(storeEvents([f["session.crashed"]])).activity.kind).toBe("crashed");
    expect(deriveTaskState(storeEvents([f["runner.lost"]])).activity.kind).toBe("runner-lost");
    expect(
      deriveTaskState(storeEvents([f["runner.lost"], f["runner.connected"]])).activity.kind,
    ).toBe("idle");
  });
});

describe("the render budget", () => {
  it("folds 5,000 events well under the budget", () => {
    const events = storeEvents(longSession(5_000));
    expect(events).toHaveLength(5_000);
    foldTaskEvents(events, []); // warm-up
    const start = performance.now();
    const first = foldTaskEvents(events, []);
    const cold = performance.now() - start;
    const again = performance.now();
    foldTaskEvents(events, [], { previous: first });
    const warm = performance.now() - again;
    console.info(
      `fold of 5,000 events: ${cold.toFixed(1)} ms, refold with identity reuse: ${warm.toFixed(1)} ms (${String(first.length)} messages)`,
    );
    expect(typesOf(first)).not.toContain("data-problem");
    // ADR 0036's bar is 1.5 s for the whole default view; the fold is a fraction of it.
    expect(cold).toBeLessThan(300);
  });
});

describe("message times", () => {
  it("stamps a member's message and an agent's turn with their first event's time", () => {
    const at = 1_795_000_000_000;
    const messages = foldTaskEvents(storeEvents([f["user.message"], f["turn.started"], f["agent.message"]], { at }), []);
    expect(messages.map((message) => [message.role, message.metadata?.at])).toEqual([
      ["user", at],
      ["assistant", at + 1],
    ]);
  });
});

describe("protocol minor 1's markers (ticket 36)", () => {
  const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000e1");
  const stored = (seq: number, event: TaskEvent): StoredEvent => storedEventSchema.parse({ taskId: "01900000-0000-7000-8000-0000000000d1", seq, sessionId, sessionSeq: seq, at: seq * 1000, event });
  const sha = "3be91f0aa5b6c7d8e9f00112233445566778899a";

  it("folds the work saved after a turn with the archive's size and the hidden refs", () => {
    // Milestone 10 (F-151): the turn's `meta.saved`; it was a `data-saved` row with the turn's ordinal.
    const turnId = turnIdSchema.parse("t-1");
    const messages = foldTaskEvents(
      [
        stored(1, { kind: "turn.started", turnId }),
        stored(2, { kind: "turn.ended", turnId, stopReason: "end_turn" }),
        stored(3, {
          kind: "session.saved",
          turnOrdinal: 1,
          repos: [{ repoId: repoIdSchema.parse("01900000-0000-7000-8000-0000000000a1"), headSha: sha, ahead: true, hiddenRefSha: sha }],
          archive: { blobId: blobIdSchema.parse("01900000-0000-7000-8000-0000000000f1"), size: 2_400_000, sha256: "a".repeat(64) },
        }),
      ],
      [],
    );
    expect(messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(messages[0]?.metadata?.saved).toEqual({ archiveBytes: 2_400_000, hiddenRefs: [sha], unsaved: 0, checks: null });
  });

  it("tags a reopen's message and a replayed one", () => {
    const messages = foldTaskEvents(
      [stored(1, { kind: "user.message", memberId: memberIdSchema.parse("01900000-0000-7000-8000-0000000000b1"), clientMessageId: clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c1"), text: "Carry on", delivery: "immediate", reopen: true })],
      [],
    );
    expect(messages[0]?.metadata?.author?.reopen).toBe(true);
  });

  it("a replayed message keeps the intent of the one it sends again, and names its sequence", () => {
    const memberId = memberIdSchema.parse("01900000-0000-7000-8000-0000000000b1");
    const round = clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c4");
    const own = clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c5");
    const messages = foldTaskEvents(
      [
        stored(1, { kind: "user.message", memberId, clientMessageId: round, text: "CI failed.", delivery: "queued", intent: "fix-ci" }),
        stored(2, { kind: "user.message", memberId, clientMessageId: own, text: "Also the README.", delivery: "queued" }),
        stored(3, { kind: "user.message", memberId, clientMessageId: round, text: "CI failed.", delivery: "queued", replayed: true }),
        stored(4, { kind: "user.message", memberId, clientMessageId: own, text: "Also the README.", delivery: "queued", replayed: true }),
      ],
      [],
    );
    const authors = messages.map((message) => message.metadata?.author);
    expect(authors[2]).toMatchObject({ replayed: true, replayOf: 1, intent: "fix-ci" });
    expect(authors[3]).toMatchObject({ replayed: true, replayOf: 2 });
    expect(authors[3]?.intent).toBeUndefined();
    expect(authors[0]?.replayOf).toBeUndefined();
  });
});


describe("queued messages (ticket 19)", () => {
  const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000e2");
  const stored = (seq: number, event: TaskEvent): StoredEvent => storedEventSchema.parse({ taskId: "01900000-0000-7000-8000-0000000000d2", seq, sessionId, sessionSeq: seq, at: seq * 1000, event });
  const memberId = memberIdSchema.parse("01900000-0000-7000-8000-0000000000b2");
  const queued = clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c2");
  const steered = clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c3");

  it("F-024/c3: a queued message reads queued to every viewer until its turn starts, then delivered after the turn", () => {
    const log = [
      stored(1, { kind: "turn.started", turnId: turnIdSchema.parse("t-1") }),
      stored(2, { kind: "user.message", memberId, clientMessageId: queued, text: "Also the key", delivery: "queued" }),
      stored(3, { kind: "user.message", memberId, clientMessageId: steered, text: "Now", delivery: "immediate" }),
      stored(4, { kind: "turn.ended", turnId: turnIdSchema.parse("t-1"), stopReason: "end_turn" }),
    ];
    const stateOf = (messages: readonly TaskUIMessage[], id: string) => messages.find((message) => message.id === `user:${id}`)?.metadata?.author?.deliveryState;
    const before = foldTaskEvents(log, []);
    expect(stateOf(before, queued)).toBe("queued");
    expect(stateOf(before, steered)).toBe("delivered");
    const after = foldTaskEvents([...log, stored(5, { kind: "turn.started", turnId: turnIdSchema.parse("t-2") })], []);
    expect(stateOf(after, queued)).toBe("delivered-after-turn");
  });
});

describe("held turns (F-037)", () => {
  const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000e3");
  const stored = (seq: number, event: TaskEvent): StoredEvent => storedEventSchema.parse({ taskId: "01900000-0000-7000-8000-0000000000d3", seq, sessionId, sessionSeq: seq, at: seq * 1000, event });
  const memberId = memberIdSchema.parse("01900000-0000-7000-8000-0000000000b3");
  const message = clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c4");
  const later = clientMessageIdSchema.parse("01900000-0000-7000-8000-0000000000c5");
  const budgetId = f["turn.held"].budgetId;
  const authorOf = (messages: readonly TaskUIMessage[], id: string) => messages.find((one) => one.id === `user:${id}`)?.metadata?.author;

  it("F-037/c4: a message the budget held reads held, with the held row after it, until the release lets its turn start", () => {
    const log = [
      stored(1, { kind: "turn.started", turnId: turnIdSchema.parse("t-1") }),
      stored(2, { kind: "turn.ended", turnId: turnIdSchema.parse("t-1"), stopReason: "end_turn" }),
      stored(3, { kind: "user.message", memberId, clientMessageId: message, text: "Also add a line about tests", delivery: "queued" }),
      stored(4, { kind: "turn.held", origin: "message", budgetId, scope: "project" }),
    ];
    const held = foldTaskEvents(log, []);
    expect(authorOf(held, message)).toMatchObject({ held: true, deliveryState: "queued" });
    const row = held.at(-1)?.parts.find((part) => part.type === "data-held");
    expect(row).toMatchObject({ data: { origin: "message", scope: "project", at: 4000 } });

    const released = foldTaskEvents([...log, stored(5, { kind: "turn.released", budgetId })], []);
    expect(authorOf(released, message)?.held).toBeUndefined();
    expect(released.at(-1)?.parts.map((part) => part.type)).toEqual(["data-released"]);
    const started = foldTaskEvents([...log, stored(5, { kind: "turn.released", budgetId }), stored(6, { kind: "turn.started", turnId: turnIdSchema.parse("t-2") })], []);
    expect(authorOf(started, message)).toMatchObject({ deliveryState: "delivered-after-turn" });
  });

  it("F-037/c4: a queued message under a running turn isn't held, and a held dispatch holds no message", () => {
    const log = [
      stored(1, { kind: "turn.started", turnId: turnIdSchema.parse("t-1") }),
      stored(2, { kind: "user.message", memberId, clientMessageId: later, text: "Then the docs", delivery: "queued" }),
      stored(3, { kind: "turn.ended", turnId: turnIdSchema.parse("t-1"), stopReason: "end_turn" }),
      stored(4, { kind: "turn.held", origin: "dispatch", budgetId, scope: "organization" }),
    ];
    expect(authorOf(foldTaskEvents(log, []), later)?.held).toBeUndefined();
  });
});

describe("memory proposals (F-111)", () => {
  it("F-111/c1: an agent's proposal is a row in the thread with its title, and a note's use is none", () => {
    const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000e4");
    const stored = (seq: number, event: TaskEvent): StoredEvent => storedEventSchema.parse({ taskId: "01900000-0000-7000-8000-0000000000d4", seq, sessionId, sessionSeq: seq, at: seq * 1000, event });
    const messages = foldTaskEvents(
      [
        stored(1, { kind: "turn.started", turnId: turnIdSchema.parse("t-1") }),
        stored(2, f["memory.used"]),
        stored(3, f["memory.proposed"]),
      ],
      [],
    );
    const parts = messages.flatMap((message) => message.parts);
    expect(parts.filter((part) => part.type === "data-memory-proposed")).toEqual([
      expect.objectContaining({ data: { proposalId: f["memory.proposed"].proposalId, title: f["memory.proposed"].title } }),
    ]);
    expect(parts.some((part) => part.type === "data-system")).toBe(false);
  });
});

describe("an accepted @ostra comment (F-111)", () => {
  it("F-111/c1: pr.comment_received is a row with its seq, URL, login and line, for Remember this, and its neighbours draw none", () => {
    const sessionId = sessionIdSchema.parse("01900000-0000-7000-8000-0000000000e5");
    const stored = (seq: number, event: TaskEvent): StoredEvent => storedEventSchema.parse({ taskId: "01900000-0000-7000-8000-0000000000d5", seq, sessionId, sessionSeq: seq, at: seq * 1000, event });
    const parts = foldTaskEvents([stored(1, { kind: "turn.started", turnId: turnIdSchema.parse("t-1") }), stored(5, f["diff.comments_sent"]), stored(6, f["ticket.closed"]), stored(7, f["pr.comment_received"])], []).flatMap((message) => message.parts);
    expect(parts.filter((part) => part.type === "data-pr-comment")).toEqual([
      expect.objectContaining({ id: "pr-comment:7", data: { seq: 7, url: f["pr.comment_received"].url, login: "ostra-test-member", path: "src/add.ts", line: 12 } }),
    ]);
  });
});
