import { appProcessesInTx, decideEnvironmentProposal, environmentBaselineInTx, environmentBaselineSchema, keptProcessWithoutCommand, startOnboarding } from "@ostra/domain";
import type { AppProcess, EnvironmentBaseline, EnvironmentDecision } from "@ostra/domain";
import { environmentProposalIdSchema, environmentProposalSchema, projectIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { EnvironmentProposal, ProposedCheck, ProposedService } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { memberProcedure, projectProcedure, unwrap } from "../trpc/init.ts";
import { keptByOf } from "./environment-app.ts";
import { attachmentViewsOf } from "./task-attachments.ts";

// F-113 (milestone 6's ticket 29; spec section 4, "The onboarding task"; ADR 0038 amended): the
// onboarding task and its environment proposal in the panel. `environments.startOnboarding` is a
// project admin's, refused while the project's onboarding task is open. `environments.proposal`
// shows the open proposal against the environment as saved now, per repo: the setup script, the
// checks and the variables it needs by name; then the services, the agent's notes and the task.
// With none open, the one decided in the last 7 days, read-only, against the environment as its
// decision found it (ticket 41).
// `environments.decideProposal` is a project admin's: accept, edit and accept (the edit scanned for
// secret values as the agent's proposal was) or reject. The scripts and the notes are the agent's
// words and the repos' code: they go to the project's members and never to a log line.

const projectInput = z.strictObject({ projectId: projectIdSchema });

type CheckRow = { readonly name: string; readonly command: string; readonly timeoutSeconds: number };
type ServiceRow = { readonly name: string; readonly image: string; readonly port: number | null; readonly healthCheck: string | null };

/** Lists by name, as "Accept" applies them: the proposal's are written, the ones it doesn't name are kept. */
const byName = <Current extends { readonly name: string }, Proposed extends { readonly name: string }>(
  current: readonly Current[],
  proposed: readonly Proposed[],
  same: (one: Current, other: Proposed) => boolean,
) => ({
  added: proposed.filter((one) => !current.some((other) => other.name === one.name)),
  changed: proposed.flatMap((one) => {
    const was = current.find((other) => other.name === one.name);
    return was === undefined || same(was, one) ? [] : [{ name: one.name, current: was, proposed: one }];
  }),
  unchanged: proposed.filter((one) => current.some((other) => other.name === one.name && same(other, one))).map((one) => one.name),
  /** The saved ones the proposal doesn't name: "Accept" keeps them. */
  kept: current.filter((one) => !proposed.some((other) => other.name === one.name)).map((one) => one.name),
});

const sameCheck = (one: CheckRow, other: ProposedCheck): boolean => one.command === other.command && one.timeoutSeconds === other.timeoutSeconds;
/** Milestone 8 (F-140): two app processes alike in every field "Accept" writes. */
const sameProcess = (one: AppProcess, other: AppProcess): boolean =>
  one.repoId === other.repoId &&
  one.folder === other.folder &&
  one.command === other.command &&
  one.port === other.port &&
  JSON.stringify(one.ready) === JSON.stringify(other.ready) &&
  one.label === other.label &&
  one.primary === other.primary &&
  one.hostRewrite === other.hostRewrite;
const sameService = (one: ServiceRow, other: ProposedService): boolean => one.image === other.image && one.port === other.port && one.healthCheck === other.healthCheck;

/** What a decision is, as the panel sends it, in the domain's terms. */
const decisionOf = (input: { readonly decision: "accept" | "edit-and-accept" | "reject"; readonly edited: EnvironmentProposal | null; readonly reason: string | null }): EnvironmentDecision => {
  switch (input.decision) {
    case "accept":
      return { kind: "accept", edited: null };
    case "edit-and-accept":
      if (input.edited === null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Edit and accept needs the edited proposal" });
      }
      return { kind: "accept", edited: input.edited };
    case "reject":
      return input.reason === null ? { kind: "reject" } : { kind: "reject", reason: input.reason };
    default:
      return input.decision satisfies never;
  }
};

/** A `commit.filtered` event's paths the runner left out (ticket 36: the panel's "Not committed"). */
const filteredSchema = z.looseObject({ dropped: z.array(z.string()).catch([]) });

/** The task states an onboarding task is over in (ticket 21's `ENDED`). */
const ENDED_STATES: readonly string[] = ["stopped", "merged", "done"];

/** How long a decided proposal stays readable on the Proposal tab (environment-proposal.md, "Accepted"). */
export const DECIDED_PROPOSAL_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

const proposalSelect = {
  id: true,
  environmentId: true,
  taskId: true,
  body: true,
  notes: true,
  createdAt: true,
  state: true,
  decidedAt: true,
  decidedByMemberId: true,
  resultVersion: true,
  baseline: true,
  source: true,
  task: { select: { title: true, state: true } },
} as const;

export const onboardingProcedures = {
  /**
   * Ticket 36: the project's newest onboarding task, for the environment page's task line and its
   * "Test this environment": its state, its `AGENTS.md` pull requests, the paths its commits left
   * out, and whether this member may start one now.
   */
  onboarding: projectProcedure("read", projectInput).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const task = await db.task.findFirst({
      where: { organizationId, projectId: input.projectId, onboarding: true },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, state: true, ticketKey: true, createdAt: true, updatedAt: true, repos: { select: { prNumber: true, prUrl: true, state: true, repo: { select: { fullName: true } } } } },
    });
    const open = task !== null && !ENDED_STATES.includes(task.state);
    const proposalOpen = (await db.environmentProposal.count({ where: { organizationId, projectId: input.projectId, state: "proposed" } })) > 0;
    // The task's last decided proposal, so the page says what became of it after a reload too.
    const decidedRow =
      task === null
        ? null
        : await db.environmentProposal.findFirst({
            where: { organizationId, taskId: task.id, state: { in: ["accepted", "rejected"] }, decidedAt: { not: null } },
            orderBy: { decidedAt: "desc" },
            select: { state: true, resultVersion: true, decidedAt: true },
          });
    const decidedAt = decidedRow?.decidedAt ?? null;
    const filtered =
      task === null
        ? []
        : (await db.event.findMany({ where: { organizationId, taskId: task.id, kind: "commit.filtered" }, orderBy: { seq: "asc" }, select: { payload: true } })).flatMap((event) => {
            const parsed = filteredSchema.safeParse(event.payload);
            return parsed.success ? parsed.data.dropped : [];
          });
    return {
      task:
        task === null
          ? null
          : {
              taskId: taskIdSchema.parse(task.id),
              key: task.ticketKey ?? task.id.replaceAll("-", "").slice(-8),
              title: task.title,
              state: task.state,
              startedAt: task.createdAt.getTime(),
              updatedAt: task.updatedAt.getTime(),
              open,
              /** The `AGENTS.md` pull requests it opened, by repo. */
              prs: task.repos.flatMap((repo) => (repo.prNumber === null || repo.prUrl === null ? [] : [{ repo: repo.repo.fullName, number: repo.prNumber, url: repo.prUrl, state: repo.state }])),
            },
      /** What a project admin decided on the task's last proposal: accepted (as a version) or rejected; `null` when none was decided. */
      decision:
        decidedRow === null || decidedAt === null
          ? null
          : decidedRow.state === "accepted"
            ? { kind: "accepted" as const, version: decidedRow.resultVersion, at: decidedAt.getTime() }
            : { kind: "rejected" as const, version: null, at: decidedAt.getTime() },
      /** The paths its commits left out: only `AGENTS.md` is committed. */
      notCommitted: [...new Set(filtered)].slice(0, 50),
      /** A project admin starts one while none is open and no proposal waits. */
      canStart: ctx.project.role === "admin" && !open && !proposalOpen,
      isAdmin: ctx.project.role === "admin",
    };
  }),

  /** "Test this environment": the onboarding task, from the built-in template. A project admin's; one open at a time. */
  startOnboarding: projectProcedure("admin", projectInput).mutation(async ({ ctx, input }) => {
    const { db, ports, logger } = ctx.deps;
    const started = await startOnboarding(
      { db, jobs: ports.jobs, notices: ports.notices, audit: ports.audit, clock: ports.clock, adapters: { codeHost: ports.adapters.codeHost, secretStore: ports.adapters.secretStore }, logger },
      ctx.scope,
      { projectId: input.projectId },
    );
    const made = unwrap(started, {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "already-running": "CONFLICT",
      "runner-not-yours": "FORBIDDEN",
      "provider-not-allowed-on-personal-runners": "PRECONDITION_FAILED",
      "no-provider-for-model": "PRECONDITION_FAILED",
      "no-agent-profile": "PRECONDITION_FAILED",
      "no-repo": "PRECONDITION_FAILED",
      "repo-unsupported": "PRECONDITION_FAILED",
      "prompt-required": "BAD_REQUEST",
      "file-not-found": "BAD_REQUEST",
    });
    return { taskId: made.taskId };
  }),

  /**
   * The open proposal against the environment as saved now: per repo its setup script, its checks
   * and the variables it names; the services; the notes and the task. With none open, the one
   * decided in the last 7 days, read-only, against the environment as its decision found it
   * (ticket 41). `null` otherwise.
   */
  proposal: projectProcedure("read", projectInput).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const open = await db.environmentProposal.findFirst({ where: { organizationId, projectId: input.projectId, state: "proposed" }, orderBy: { createdAt: "desc" }, select: proposalSelect });
    const decidedRow =
      open !== null
        ? null
        : await db.environmentProposal.findFirst({
            where: { organizationId, projectId: input.projectId, state: { in: ["accepted", "rejected"] }, decidedAt: { gte: new Date(ctx.deps.ports.clock.now() - DECIDED_PROPOSAL_SHOWN_MS) } },
            orderBy: { decidedAt: "desc" },
            select: proposalSelect,
          });
    // A proposal decided before its baseline was kept has only its outcome to show (the onboarding line says it).
    const kept = decidedRow === null ? null : environmentBaselineSchema.safeParse(decidedRow.baseline);
    const row = open ?? (kept?.success === true ? decidedRow : null);
    if (row === null) {
      return null;
    }
    const current: EnvironmentBaseline = kept?.success === true ? kept.data : await environmentBaselineInTx(db, row.environmentId);
    // A body that doesn't parse (a shape this version doesn't read) is shown as unreadable: only rejecting it is left.
    const parsed = environmentProposalSchema.safeParse(row.body);
    const proposal: EnvironmentProposal = parsed.success ? parsed.data : { repos: [], services: [], notes: row.notes ?? "" };
    const repos = await db.repo.findMany({ where: { organizationId, projectId: input.projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true, fullName: true } });
    const decidedBy =
      row.decidedByMemberId === null ? null : await db.member.findFirst({ where: { id: row.decidedByMemberId, organizationId }, select: { user: { select: { name: true } } } });
    const decidedAt = row.decidedAt?.getTime() ?? null;
    const saved = current.saved;
    const firstRepoId = repos[0]?.id ?? null;
    // Milestone 8 (F-140, ticket 16): the app's processes against the environment's now, while it's
    // open (a decided proposal's baseline keeps no processes); who kept it from a task; and the
    // onboarding task's newest screenshot of the app it started.
    const proposedApps: readonly AppProcess[] = proposal.appProcesses ?? [];
    const savedApps = row.state === "proposed" ? await appProcessesInTx(db, row.environmentId) : null;
    const screenshots = (await attachmentViewsOf(db, organizationId, [taskIdSchema.parse(row.taskId)])).filter((attachment) => attachment.kind === "screenshot");
    return {
      proposalId: environmentProposalIdSchema.parse(row.id),
      createdAt: row.createdAt.getTime(),
      task: { taskId: taskIdSchema.parse(row.taskId), title: row.task.title, state: row.task.state },
      /** Ticket 41: what a project admin decided, for a proposal decided in the last 7 days; `null` while it's open. */
      decision:
        row.state === "proposed" || decidedAt === null
          ? null
          : row.state === "accepted"
            ? { kind: "accepted" as const, version: row.resultVersion, at: decidedAt, byName: decidedBy?.user.name ?? null }
            : { kind: "rejected" as const, version: null, at: decidedAt, byName: decidedBy?.user.name ?? null },
      /** Whether the environment was saved before; a draft one has nothing to compare against. */
      saved,
      /** Only a project admin decides it, and only while it's open. */
      canDecide: ctx.project.role === "admin" && row.state === "proposed",
      /** Whether the proposal could be read; one that can't is shown without its parts. */
      readable: parsed.success,
      notes: proposal.notes,
      /** As proposed: what "Edit and accept" starts from; `null` once it's decided. */
      body: parsed.success && row.state === "proposed" ? proposal : null,
      repos: proposal.repos.map((repo) => {
        const isFirst = repo.repoId === firstRepoId;
        // The environment's one setup script runs in the workspace: it's compared with the first repo's.
        const currentScript = saved && isFirst ? current.setupScript : null;
        const currentChecks = saved ? current.checks.filter((check) => check.repoId === repo.repoId || (check.repoId === null && isFirst)) : [];
        const currentNames = new Set(current.names.filter((entry) => entry.repoId === repo.repoId).map((entry) => entry.name));
        return {
          repoId: repoIdSchema.parse(repo.repoId),
          repo: repos.find((one) => one.id === repo.repoId)?.fullName ?? null,
          setupScript: { current: currentScript, proposed: repo.setupScript, changed: (currentScript ?? "") !== (repo.setupScript ?? "") },
          checks: byName(
            currentChecks.map((check) => ({ name: check.name, command: check.command, timeoutSeconds: check.timeoutSeconds })),
            repo.checks,
            sameCheck,
          ),
          /** The names it needs: the ones the environment has no value for yet, for an admin to set. */
          variableNames: { missing: repo.variableNames.filter((name) => !currentNames.has(name)), present: repo.variableNames.filter((name) => currentNames.has(name)) },
        };
      }),
      services: byName(
        saved ? current.services : [],
        proposal.services,
        sameService,
      ),
      /** Milestone 8 (F-140): onboarding's proposal, or a port an agent announced and a member kept ("Keep it"). */
      source: row.source,
      /** Who kept it from a task; `null` for onboarding's. */
      keptBy: row.source === "kept" ? await keptByOf(db, organizationId, row.id) : null,
      /**
       * The app's processes as proposed, each in place of the one of its name or port on "Accept";
       * against the environment's while it's open, and `null` once it's decided.
       */
      appProcesses: { proposed: [...proposedApps], diff: savedApps === null ? null : byName(savedApps, proposedApps, sameProcess) },
      /** A kept process without the command that starts it: "Accept" waits for "Edit and accept" to name it. */
      waitsForCommand: row.source === "kept" ? (keptProcessWithoutCommand(proposedApps)?.name ?? null) : null,
      /** The proposal's task's newest screenshot of the app, as onboarding took it of the primary. */
      screenshot: screenshots.at(-1) ?? null,
    };
  }),

  /** A project admin's decision: accept, edit and accept, or reject (with a reason the audit entry records the presence of). */
  decideProposal: memberProcedure
    .input(
      z.strictObject({
        proposalId: environmentProposalIdSchema,
        decision: z.enum(["accept", "edit-and-accept", "reject"]),
        edited: environmentProposalSchema.nullable(),
        reason: z.string().trim().max(2000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const decided = await decideEnvironmentProposal({ db, ...ports }, ctx.scope, { proposalId: input.proposalId, decision: decisionOf(input) });
      if (!decided.ok && decided.error === "secret-found") {
        throw new TRPCError({ code: "BAD_REQUEST", message: decided.message });
      }
      const result = unwrap(decided, {
        forbidden: "FORBIDDEN",
        "not-found": "NOT_FOUND",
        "already-decided": "CONFLICT",
        "invalid-input": "BAD_REQUEST",
      });
      return { resultVersion: result.resultVersion };
    }),
};
