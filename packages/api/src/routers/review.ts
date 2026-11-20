import {
  acceptedCriteriaOfTicketInTx,
  CI_FAILING_CONCLUSIONS,
  ciLogEntriesSchema,
  ciLogFileName,
  recordPersonActionInTx,
  rememberFinding,
  reviewHeadsSchema,
  roundKindFromDb,
  saveDiffComment,
  setAiReview,
  taskDiffs,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import {
  blobIdSchema,
  findingIdSchema,
  memberIdSchema,
  memoryKindSchema,
  projectIdSchema,
  repoIdSchema,
  reviewRunIdSchema,
  runnerLimits,
  taskIdSchema,
  taskRepoIdSchema,
  ticketKeySchema,
} from "@ostra/protocol";
import type { FindingId, MemberId, OrganizationId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../trpc/context.ts";
import { loadProjectAccess, memberProcedure, projectProcedure, router, taskProcedure, unwrap } from "../trpc/init.ts";
import { diffFileViews } from "./diff.ts";

// F-102, F-100, F-101, F-035, F-105, F-111 (milestone 6's ticket 28; spec section 4): the review
// screen of a code task, its rounds, and a project's "Review" settings.
//
// - `review.screen`: per PR, its diff (milestone 3's compare, cached by head) with its files, the
//   findings of every review run on it with their state, its CI and its reviewers; the ticket with
//   its acceptance criteria (the applied refine draft's, else the ticket's text); the round line.
// - `review.fixThis`: a finding becomes the member's draft line comment on its line (milestone 3),
//   so "Send to agent" sends it with the rest as one prompt. `review.rememberFinding`: a memory
//   proposal from the finding (ticket 17's `rememberFinding`).
// - `tasks.rounds`: each round with its cause and its state, a held one with its reason.
// - `projects.reviewSettings` and `projects.setAiReview`: the switch is a project admin's; the
//   round limits are the install's, shown here and changed nowhere in the panel.
//
// Findings, reviews and logs hold the repo's code and people's words: they go to members of the
// project and never to a log line. Nothing here approves or merges a PR.

const taskInput = z.strictObject({ taskId: taskIdSchema });

type MemberContext = Context & { readonly scope: MemberScope };

const nameMap = async (ctx: Context, organizationId: OrganizationId, ids: readonly (string | null)[]): Promise<ReadonlyMap<string, string>> => {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await ctx.deps.db.member.findMany({ where: { organizationId, id: { in: wanted } }, select: { id: true, user: { select: { name: true } } } });
  return new Map(rows.map((row) => [row.id, row.user.name]));
};

const person = (names: ReadonlyMap<string, string>, id: string | null): { readonly memberId: MemberId; readonly name: string } | null =>
  id === null ? null : { memberId: memberIdSchema.parse(id), name: names.get(id) ?? "A former member" };

/** A CI run's checks as `ci.evaluate` stores them: the name, the conclusion and the check's ID. */
const storedChecksSchema = z.array(z.looseObject({ name: z.string(), conclusion: z.string().nullable().optional() }));

const checksOf = (stored: unknown): readonly { readonly name: string; readonly conclusion: string | null }[] => {
  const parsed = storedChecksSchema.safeParse(stored);
  return parsed.success ? parsed.data.map((check) => ({ name: check.name, conclusion: check.conclusion ?? null })) : [];
};

/** The round limits as the install sets them: the panel shows them and changes none. */
const limitsOf = (ctx: Context) => ctx.deps.settings.team.roundLimits;

/** A finding inside a project the member may open, with its code task and the head it was found on; else `NOT_FOUND`. */
const loadFinding = async (ctx: MemberContext, findingId: FindingId) => {
  const finding = await ctx.deps.db.finding.findFirst({
    where: { id: findingId, organizationId: ctx.scope.organizationId },
    select: {
      id: true,
      projectId: true,
      taskRepoId: true,
      path: true,
      line: true,
      side: true,
      title: true,
      body: true,
      suggestion: true,
      reviewRun: { select: { codeTaskId: true, heads: true } },
      taskRepo: { select: { repoId: true } },
    },
  });
  if (finding === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such finding" });
  }
  try {
    await loadProjectAccess(ctx.deps.db, ctx.scope, projectIdSchema.parse(finding.projectId), "read");
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such finding" });
    }
    throw error;
  }
  return finding;
};

/** A finding as the member's draft line comment: its title, its words and its suggestion. */
const fixThisBody = (finding: { readonly title: string; readonly body: string; readonly suggestion: string | null }): string => {
  const parts = [finding.title.replaceAll(/[\r\n]+/g, " "), finding.body, ...(finding.suggestion === null ? [] : [`Suggested:\n${finding.suggestion}`])];
  return parts.join("\n\n").slice(0, runnerLimits.diffCommentMaxChars);
};

export const reviewRouter = router({
  /** The review screen of a code task: its PRs, their findings, CI and reviewers, the ticket, the round line. */
  screen: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const task = await db.task.findFirst({
      where: { id: input.taskId, organizationId },
      select: { id: true, kind: true, title: true, state: true, subState: true, ticketId: true, ciRounds: true, reviewRounds: true, automaticTurns: true, project: { select: { aiReview: true } } },
    });
    if (task?.kind !== "code") {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such code task" });
    }
    const repos = await db.taskRepo.findMany({
      where: { taskId: task.id, organizationId, prNumber: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, repoId: true, prNumber: true, prUrl: true, prTitle: true, headSha: true, state: true, branchName: true, baseBranch: true, repo: { select: { fullName: true } } },
    });
    const repoIds = repos.map((repo) => repo.id);
    const diffs = unwrap(await taskDiffs({ db, jobs: ports.jobs }, ctx.scope, { taskId: ctx.task.taskId }), { "not-found": "NOT_FOUND" });
    const [ciRuns, findings, reviewers, runs] = await Promise.all([
      db.ciRun.findMany({ where: { organizationId, taskRepoId: { in: repoIds } }, select: { taskRepoId: true, headSha: true, state: true, checks: true, firstSeenAt: true, completedAt: true } }),
      db.finding.findMany({
        where: { organizationId, taskRepoId: { in: repoIds } },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          taskRepoId: true,
          path: true,
          line: true,
          side: true,
          severity: true,
          title: true,
          body: true,
          suggestion: true,
          postedAs: true,
          state: true,
          reviewRun: { select: { id: true, round: true, state: true } },
        },
      }),
      db.taskReviewer.findMany({
        where: { organizationId, taskRepoId: { in: repoIds } },
        orderBy: [{ updatedAt: "asc" }],
        select: { taskRepoId: true, githubUserId: true, login: true, teamSlug: true, memberId: true, source: true, lastReviewState: true },
      }),
      db.reviewRun.findMany({ where: { organizationId, codeTaskId: task.id }, orderBy: { round: "asc" }, select: { id: true, round: true, state: true, summary: true, blocking: true, nits: true, postedAt: true } }),
    ]);
    const names = await nameMap(ctx, organizationId, reviewers.map((reviewer) => reviewer.memberId));
    const ticket = task.ticketId === null ? null : await db.ticket.findFirst({ where: { id: task.ticketId, organizationId }, select: { key: true, title: true, url: true, description: true } });
    const criteria = await acceptedCriteriaOfTicketInTx(db, task.ticketId);
    const limits = limitsOf(ctx);
    return {
      taskId: ctx.task.taskId,
      title: task.title,
      state: task.state,
      subState: task.subState,
      aiReview: task.project.aiReview,
      ticket:
        ticket === null
          ? null
          : {
              key: ticketKeySchema.parse(ticket.key),
              title: ticket.title,
              url: ticket.url,
              /** The applied refine draft's criteria; `null` when none was applied, and the ticket's text holds them. */
              acceptanceCriteria: criteria,
              criteriaFrom: criteria === null ? ("ticket" as const) : ("draft" as const),
              description: ticket.description,
            },
      /** The round line: the sub-state, each kind's rounds used of its limit, the automatic turns since a person acted. */
      rounds: {
        subState: task.subState,
        ci: { used: task.ciRounds, limit: limits.ciRounds },
        review: { used: task.reviewRounds, limit: limits.reviewRounds },
        automaticTurns: { used: task.automaticTurns, limit: limits.automaticTurns },
      },
      reviewRuns: runs.map((run) => ({
        reviewRunId: reviewRunIdSchema.parse(run.id),
        round: run.round,
        state: run.state,
        summary: run.summary,
        blocking: run.blocking,
        nits: run.nits,
        postedAt: run.postedAt?.getTime() ?? null,
      })),
      prs: repos.map((repo) => {
        const entry = diffs.repos.find((candidate) => candidate.taskRepoId === repo.id);
        const diff = entry?.state === "ready" ? entry.diff : null;
        const files = diffFileViews(diff);
        const prFindings = findings.filter((finding) => finding.taskRepoId === repo.id);
        const ci = ciRuns.find((run) => run.taskRepoId === repo.id && run.headSha === repo.headSha) ?? null;
        return {
          taskRepoId: taskRepoIdSchema.parse(repo.id),
          repoId: repoIdSchema.parse(repo.repoId),
          repo: repo.repo.fullName,
          prNumber: repo.prNumber,
          prUrl: repo.prUrl,
          prTitle: repo.prTitle,
          branch: repo.branchName,
          base: repo.baseBranch,
          headSha: repo.headSha,
          state: repo.state,
          ci: ci === null ? null : { state: ci.state, checks: checksOf(ci.checks), completedAt: ci.completedAt?.getTime() ?? null },
          /** `ready`, `loading` (the head's diff is being fetched) or `no-head`. */
          diffState: entry?.state ?? "no-head",
          hostUrl: diff?.hostUrl ?? null,
          /** The changed files in path order, each with its open findings' count: the screen's file tree. */
          fileTree: [...files]
            .sort((one, other) => one.path.localeCompare(other.path))
            .map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions, openFindings: prFindings.filter((finding) => finding.path === file.path && finding.state === "open").length })),
          files,
          findings: prFindings.map((finding) => ({
            findingId: findingIdSchema.parse(finding.id),
            reviewRunId: reviewRunIdSchema.parse(finding.reviewRun.id),
            round: finding.reviewRun.round,
            path: finding.path,
            line: finding.line,
            side: finding.side,
            severity: finding.severity,
            title: finding.title,
            body: finding.body,
            suggestion: finding.suggestion,
            /** Where the review put it: a line comment, or the review's body (off the diff). */
            postedAs: finding.postedAs,
            state: finding.state,
          })),
          reviewers: reviewers
            .filter((reviewer) => reviewer.taskRepoId === repo.id)
            .map((reviewer) => ({
              login: reviewer.login,
              team: reviewer.teamSlug,
              /** The member the GitHub user is linked to; `null` for a team or an unlinked user. */
              member: person(names, reviewer.memberId),
              source: reviewer.source,
              state: reviewer.lastReviewState,
            })),
        };
      }),
    };
  }),

  /**
   * "Fix this": the finding becomes the member's draft line comment on its line, on the head it was
   * found on, so "Send to agent" sends it with their other drafts as one prompt. A finding off the
   * diff (in the review's body) has no line to sit on. A person acting: the automatic turns count
   * from here again.
   */
  fixThis: memberProcedure.input(z.strictObject({ findingId: findingIdSchema })).mutation(async ({ ctx, input }) => {
    const finding = await loadFinding(ctx, input.findingId);
    const taskId = taskIdSchema.parse(finding.reviewRun.codeTaskId);
    const head = (reviewHeadsSchema.safeParse(finding.reviewRun.heads).data ?? []).find((one) => one.repoId === finding.taskRepo.repoId);
    if (head === undefined) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The review's head for this repo isn't known" });
    }
    const body = fixThisBody(finding);
    // Pressed twice: the member's draft is there already.
    const existing = await ctx.deps.db.diffComment.findFirst({
      where: { organizationId: ctx.scope.organizationId, taskId, taskRepoId: finding.taskRepoId, memberId: ctx.scope.memberId, path: finding.path, line: finding.line, side: finding.side, headSha: head.headSha, state: "draft", body },
      select: { id: true },
    });
    if (existing !== null) {
      return { commentId: existing.id, taskId };
    }
    const saved = await saveDiffComment({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, {
      action: "create",
      taskRepoId: taskRepoIdSchema.parse(finding.taskRepoId),
      path: finding.path,
      side: finding.side,
      line: finding.line,
      headSha: head.headSha,
      body,
    });
    if (!saved.ok && saved.error === "no-such-line") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This finding isn't on a line of the PR's diff: it's in the review's body" });
    }
    const draft = unwrap(saved, { "not-found": "NOT_FOUND", "not-yours": "FORBIDDEN", "no-such-line": "PRECONDITION_FAILED", "too-long": "BAD_REQUEST", sent: "CONFLICT" });
    await ctx.deps.db.$transaction((tx) => recordPersonActionInTx(tx, taskId, new Date(ctx.deps.ports.clock.now())));
    return { commentId: draft.commentId, taskId };
  }),

  /** "Remember this" on a finding: a memory proposal sourced by the finding, for the project's admins to decide. */
  rememberFinding: memberProcedure
    .input(z.strictObject({ findingId: findingIdSchema, kind: memoryKindSchema.optional(), title: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(8000).optional() }))
    .mutation(async ({ ctx, input }) => {
      await loadFinding(ctx, input.findingId);
      const result = await rememberFinding(
        { db: ctx.deps.db, audit: ctx.deps.ports.audit, clock: ctx.deps.ports.clock, adapters: { secretStore: ctx.deps.ports.adapters.secretStore } },
        ctx.scope,
        { findingId: input.findingId, ...(input.kind === undefined ? {} : { kind: input.kind }), ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { body: input.body }) },
      );
      const proposed = unwrap(result, { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND", "secret-found": "BAD_REQUEST", "invalid-input": "BAD_REQUEST" });
      return { proposalId: proposed.proposalId };
    }),
});

/** A held round's reason: the budget that holds its turn. */
type HeldReason = { readonly kind: "budget"; readonly scope: "organization" | "project" };

const cappedEventSchema = z.looseObject({ kind: z.literal("round.capped"), round: z.enum(["ci", "findings", "changes-requested"]), reason: z.enum(["rounds", "automatic-turns"]) });
const changesAuditSchema = z.looseObject({ reviewId: z.union([z.string(), z.number()]) });

/** `tasks.rounds`: each round of the task, oldest first, with its cause and its state. */
export const taskRoundsProcedure = taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
  const { db } = ctx.deps;
  const organizationId = ctx.scope.organizationId;
  const rounds = await db.taskRound.findMany({ where: { organizationId, taskId: input.taskId }, orderBy: [{ createdAt: "asc" }, { number: "asc" }] });
  const [ciRuns, findings, capped, held, changes] = await Promise.all([
    rounds.some((round) => round.kind === "ci")
      ? db.ciRun.findMany({ where: { organizationId, taskRepo: { taskId: input.taskId } }, select: { headSha: true, checks: true, logBlobIds: true, taskRepo: { select: { repo: { select: { fullName: true } } } } } })
      : [],
    rounds.some((round) => round.kind === "findings")
      ? db.finding.findMany({ where: { organizationId, reviewRunId: { in: rounds.filter((round) => round.kind === "findings").map((round) => round.causeRef) } }, orderBy: { createdAt: "asc" }, select: { id: true, reviewRunId: true, path: true, line: true, severity: true, title: true } })
      : [],
    db.event.findMany({ where: { organizationId, taskId: input.taskId, kind: "round.capped" }, orderBy: { seq: "asc" }, select: { payload: true, occurredAt: true } }),
    db.heldTurn.findMany({ where: { organizationId, taskId: input.taskId, releasedAt: null, origin: { in: ["automatic_round", "changes_requested"] } }, select: { origin: true, budget: { select: { projectId: true } } } }),
    db.auditEntry.findMany({ where: { organizationId, entityId: input.taskId, action: "pr.changes-requested" }, select: { actorId: true, data: true } }),
  ]);
  const reviewers = changes.flatMap((entry) => {
    const data = changesAuditSchema.safeParse(entry.data);
    return data.success ? [{ reviewId: String(data.data.reviewId), memberId: entry.actorId }] : [];
  });
  const names = await nameMap(ctx, organizationId, reviewers.map((reviewer) => reviewer.memberId));
  const cappedEvents = capped.flatMap((event) => {
    const parsed = cappedEventSchema.safeParse(event.payload);
    return parsed.success ? [{ ...parsed.data, at: event.occurredAt.getTime() }] : [];
  });
  return {
    limits: limitsOf(ctx),
    rounds: rounds.map((round) => {
      const kind = roundKindFromDb[round.kind];
      const cause = (() => {
        switch (round.kind) {
          case "ci": {
            const head = round.causeRef.split(".")[0] ?? "";
            const runs = ciRuns.filter((run) => run.headSha === head);
            return {
              kind: "ci" as const,
              headSha: head,
              failing: runs.flatMap((run) => {
                const logs = ciLogEntriesSchema.safeParse(run.logBlobIds);
                return checksOf(run.checks)
                  .filter((check) => check.conclusion !== null && CI_FAILING_CONCLUSIONS.has(check.conclusion))
                  .map((check) => {
                    const log = (logs.success ? logs.data : []).find((entry) => entry.name === check.name);
                    return { repo: run.taskRepo.repo.fullName, name: check.name, conclusion: check.conclusion, logFile: log === undefined ? null : ciLogFileName(blobIdSchema.parse(log.blobId)) };
                  });
              }),
            };
          }
          case "findings": {
            const sent = findings.filter((finding) => finding.reviewRunId === round.causeRef);
            return {
              kind: "findings" as const,
              reviewRunId: round.causeRef,
              /** The blocking findings the round sent to fix; the nits it listed only. */
              findings: sent.map((finding) => ({ findingId: findingIdSchema.parse(finding.id), title: finding.title, path: finding.path, line: finding.line, severity: finding.severity })),
            };
          }
          case "changes_requested": {
            const by = reviewers.find((reviewer) => reviewer.reviewId === round.causeRef);
            return { kind: "changes-requested" as const, reviewId: round.causeRef, by: person(names, by?.memberId ?? null) };
          }
          default:
            return round.kind satisfies never;
        }
      })();
      const createdAt = round.createdAt.getTime();
      const cappedBy = round.state === "capped" ? (cappedEvents.filter((event) => event.round === kind).sort((one, other) => Math.abs(one.at - createdAt) - Math.abs(other.at - createdAt))[0] ?? null) : null;
      const heldTurn = round.state === "held" ? (held.find((turn) => turn.origin === (round.kind === "changes_requested" ? "changes_requested" : "automatic_round")) ?? null) : null;
      const heldReason: HeldReason | null = heldTurn === null ? null : { kind: "budget", scope: heldTurn.budget.projectId === null ? "organization" : "project" };
      return {
        kind,
        number: round.number,
        automatic: round.automatic,
        state: round.state,
        createdAt,
        cause,
        /** Why a capped round didn't start: its kind's rounds, the automatic turns, or the task's spend cap. */
        cappedReason: round.state === "capped" ? (cappedBy?.reason ?? ("spend-cap" as const)) : null,
        /** Why a held round waits: the budget holding its turn, until it's raised or the month turns. */
        heldReason,
      };
    }),
  };
});

/** A project's "Review" settings: the AI review switch (a project admin's) and the install's round limits. */
export const projectReviewProcedures = {
  reviewSettings: projectProcedure("read", z.strictObject({ projectId: projectIdSchema })).query(async ({ ctx, input }) => {
    const project = await ctx.deps.db.project.findFirst({ where: { id: input.projectId, organizationId: ctx.scope.organizationId }, select: { aiReview: true } });
    if (project === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
    }
    const caps = ctx.deps.ports.adapters.codeHost.capabilities;
    // Ticket 35: each repo's CI as ostra last saw it, on the newest head any task pushed there.
    const repos = await ctx.deps.db.repo.findMany({ where: { organizationId: ctx.scope.organizationId, projectId: input.projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, fullName: true } });
    const runs = await ctx.deps.db.ciRun.findMany({
      where: { organizationId: ctx.scope.organizationId, projectId: input.projectId },
      orderBy: { firstSeenAt: "desc" },
      take: 200,
      select: { headSha: true, state: true, checks: true, firstSeenAt: true, completedAt: true, taskRepo: { select: { repoId: true, task: { select: { id: true, ticketKey: true } } } } },
    });
    return {
      repos: repos.map((repo) => {
        const run = runs.find((one) => one.taskRepo.repoId === repo.id);
        return {
          repoId: repoIdSchema.parse(repo.id),
          fullName: repo.fullName,
          ci:
            run === undefined
              ? null
              : {
                  state: run.state,
                  checks: checksOf(run.checks),
                  headSha: run.headSha,
                  taskId: taskIdSchema.parse(run.taskRepo.task.id),
                  taskKey: run.taskRepo.task.ticketKey,
                  at: (run.completedAt ?? run.firstSeenAt).getTime(),
                },
        };
      }),
      aiReview: project.aiReview,
      /** Whether this member may turn it on or off. */
      canChange: ctx.project.role === "admin",
      /** The install's limits (`OSTRA_CI_ROUNDS`, `OSTRA_REVIEW_ROUNDS`, `OSTRA_AUTOMATIC_TURNS`): read-only here. */
      limits: limitsOf(ctx),
      /** What the code host can do: without comment-type reviews there is no AI review, without CI results no CI rounds. */
      codeHost: { ciResults: caps.ciResults, reviewComments: caps.reviewComments },
    };
  }),

  setAiReview: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, on: z.boolean() })).mutation(async ({ ctx, input }) => {
    const set = unwrap(await setAiReview({ db: ctx.deps.db, audit: ctx.deps.ports.audit, notices: ctx.deps.ports.notices }, ctx.scope, input), { forbidden: "FORBIDDEN", "not-found": "NOT_FOUND" });
    return { aiReview: set.on };
  }),
};
