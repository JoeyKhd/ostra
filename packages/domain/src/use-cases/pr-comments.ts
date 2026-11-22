import type { CodeHostAdapter, Logger } from "@ostra/adapter-sdk";
import { clientMessageIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope, ProjectRole } from "../access.ts";
import { prCommentPrompt } from "../prompts/index.ts";
import { githubNoReplyAddress } from "./github-link.ts";
import type { M3Deps, AcceptPrComment } from "./m3-signatures.ts";
import { sendMemberMessageInTx } from "./member-message.ts";
import type { SendMemberMessageDeps } from "./member-message.ts";
import { repoAccessFor } from "./repo-access.ts";
import { appendServerEvent } from "./server-events.ts";

// `@ostra` on a task's PR (F-053, ADR 0052, ADR 0041; ticket 25). A comment on the PR's
// conversation, or on a line of its diff, that starts with `@ostra` (or holds it on a line of its
// own) becomes a member message from the member whose verified GitHub link (F-119) wrote it, as long
// as they can open the task's project. Then ostra reacts 👀 on the comment, writes
// `pr.comment_received`, and sends the message: queued for the turn's end while a session is going,
// whoever drives, or a reopen with none. Anyone else (unlinked, without access, a bot) is recorded
// by IDs and dropped, with no reply. Comment text is untrusted: never logged, never in a shell.

const MENTION_AT_START = /^\s*@ostra(?![\w-])[\s:,]*/i;
/** A line of the comment that starts with `@ostra`, alone or followed by the ask. */
const MENTION_LINE = /^[ \t]*@ostra(?![\w-])[ \t:,]*(.*)$/i;

/**
 * The text a comment asks ostra, or `null` when it doesn't ask: it starts with `@ostra` (after
 * whitespace, any case), or holds `@ostra` on a line of its own, followed by the ask (or after it,
 * when nothing follows). A mention inside a sentence, or another account such as `@ostra-bot`, isn't
 * an ask. Pure.
 */
export const ostraMentionText = (body: string): string | null => {
  const start = MENTION_AT_START.exec(body);
  if (start !== null) {
    return body.slice(start[0].length).trim();
  }
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => MENTION_LINE.test(line));
  const line = lines[at];
  if (line === undefined) {
    return null;
  }
  const rest = MENTION_LINE.exec(line)?.[1] ?? "";
  const after = [rest, ...lines.slice(at + 1)].join("\n").trim();
  return after === "" ? lines.slice(0, at).join("\n").trim() : after;
};

/** Why a comment was dropped, by IDs: words for the delivery's record, never its text. */
export type PrCommentDrop = "no-task" | "unlinked" | "no-access";

export type AcceptPrCommentInput = Parameters<AcceptPrComment>[1] & {
  /** A comment on the PR's conversation, or on a line of its diff: which kind the reaction names. */
  readonly kind: "issue" | "review";
};

export type AcceptPrCommentExtras = Pick<SendMemberMessageDeps, "spendCap" | "timers"> & { readonly logger?: Logger };

/** The member scope of a linked GitHub user in the task's organization, or `null`. */
const linkedMemberScope = async (deps: Pick<M3Deps, "db">, organizationId: OrganizationId, githubUserId: string): Promise<{ readonly scope: MemberScope } | null> => {
  const user = await deps.db.user.findFirst({ where: { githubUserId }, select: { id: true } });
  if (user === null) {
    return null;
  }
  const member = await deps.db.member.findUnique({ where: { organizationId_userId: { organizationId, userId: user.id } }, select: { id: true, role: true, state: true } });
  // A removed member keeps their GitHub link on their account, and is heard no more than a stranger.
  if (member?.state !== "active") {
    return null;
  }
  const memberId = memberIdSchema.parse(member.id);
  const listed = await deps.db.projectMember.findMany({ where: { organizationId, memberId }, select: { projectId: true, role: true } });
  const projectRoles = new Map<ProjectId, ProjectRole>(listed.map((row) => [projectIdSchema.parse(row.projectId), row.role] as const));
  return { scope: { organizationId, memberId, role: member.role === "admin" ? "admin" : "member", projectRoles } };
};

/** `acceptPrComment`, with the server's spend cap and session timers for a reopen. */
export const acceptPrCommentWith = async (deps: M3Deps, extras: AcceptPrCommentExtras, input: AcceptPrCommentInput): ReturnType<AcceptPrComment> => {
  // The task by its PR: every PR a task repo has had, then the repo's current one. The repo's row
  // is the organization's, so another organization's task is never matched.
  const repo = await deps.db.repo.findUnique({ where: { id: input.repoId }, select: { id: true, organizationId: true } });
  if (repo === null) {
    return { ok: false, error: "no-task", message: "no task has this PR" };
  }
  const organizationId = organizationIdSchema.parse(repo.organizationId);
  const kept = await deps.db.taskPullRequest.findFirst({ where: { organizationId, number: input.prNumber, taskRepo: { repoId: repo.id } }, orderBy: { openedAt: "desc" }, select: { taskRepo: { select: { taskId: true } } } });
  const current = kept === null ? await deps.db.taskRepo.findFirst({ where: { organizationId, repoId: repo.id, prNumber: input.prNumber }, select: { taskId: true } }) : null;
  const taskIdRaw = kept?.taskRepo.taskId ?? current?.taskId ?? null;
  if (taskIdRaw === null) {
    return { ok: false, error: "no-task", message: "no task has this PR" };
  }
  const taskId = taskIdSchema.parse(taskIdRaw);
  const task = await deps.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
  const projectId = projectIdSchema.parse(task.projectId);
  // The commenter by their verified link, a member of the task's organization (F-119).
  const linked = await linkedMemberScope(deps, organizationId, input.commenterGithubUserId);
  if (linked === null) {
    return { ok: false, error: "not-a-member", message: "the commenter isn't a linked member" };
  }
  if (!requireProjectAccess(linked.scope, { id: projectId, organizationId, access: task.project.access }, "read").ok) {
    return { ok: false, error: "no-access", message: "the commenter can't open the task's project" };
  }
  // A replayed delivery, or an edit of a comment already accepted: nothing more.
  const clientMessageId = clientMessageIdSchema.parse(`pr-comment:${input.kind}:${input.commentId}`);
  const seen = await deps.db.event.findFirst({ where: { taskId, kind: "user.message", payload: { path: ["clientMessageId"], equals: clientMessageId } }, select: { payload: true } });
  if (seen !== null) {
    const reopen = typeof seen.payload === "object" && seen.payload !== null && "reopen" in seen.payload;
    return { ok: true, taskId, delivery: reopen ? "reopen" : "queued" };
  }
  // 👀: seen. Idempotent on the host, by the comment's ID; a failure never holds the message back.
  if (deps.adapters.codeHost.capabilities.prComments) {
    await react(deps.adapters.codeHost, deps, organizationId, input, extras.logger);
  }
  return deps.db.$transaction(
    async (tx) => {
      const sent = await sendMemberMessageInTx({ ...deps, ...extras }, tx, linked.scope, {
        taskId,
        clientMessageId,
        text: prCommentPrompt({ login: input.commenterLogin, text: input.text, url: input.url, path: input.path, line: input.line }),
        intent: "pr-comment",
        sender: "anyone",
        // The member is a co-author of what follows (ADR 0040), by the link's no-reply address (ADR
        // 0052), credited with the message, so a steer into a going session carries them (F-078). A
        // new co-author is a new driver, whose approval no longer counts as independent (F-104).
        credit: { email: githubNoReplyAddress(input.commenterGithubUserId, input.commenterLogin) },
      });
      if (!sent.ok) {
        // A comment carries no file, so it never meets a runner too old for one.
        const dropped = sent.error === "take-over-to-send" || sent.error === "not-found" || sent.error === "runner-needs-upgrade";
        return { ok: false, error: dropped ? "no-task" : sent.error, message: sent.message };
      }
      if (sent.duplicate) {
        return { ok: true, taskId, delivery: sent.delivery === "reopen" ? "reopen" : "queued" };
      }
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId,
        sessionId: sent.sessionId,
        at: deps.clock.now(),
        event: {
          kind: "pr.comment_received",
          url: input.url,
          login: input.commenterLogin.slice(0, 100),
          path: input.path === null ? null : input.path.slice(0, 1024),
          line: input.line !== null && input.line > 0 ? input.line : null,
        },
      });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: linked.scope.memberId },
        action: "pr.comment-accepted",
        entity: "task",
        entityId: taskId,
        data: { repoId: input.repoId, prNumber: input.prNumber, commentId: input.commentId, delivery: sent.delivery },
      });
      return { ok: true, taskId, delivery: sent.delivery === "reopen" ? "reopen" : "queued" };
    },
    { timeout: 20_000 },
  );
};

const react = async (codeHost: CodeHostAdapter, deps: Pick<M3Deps, "db" | "adapters">, organizationId: OrganizationId, input: AcceptPrCommentInput, logger: Logger | undefined): Promise<void> => {
  const access = await repoAccessFor(deps.db, deps.adapters.secretStore, organizationId, repoIdSchema.parse(input.repoId));
  if (!access.ok) {
    logger?.warn("pr.comment-reaction-skipped", { repoId: input.repoId, commentId: input.commentId, reason: access.reason });
    return;
  }
  const reacted = await codeHost.addReaction(access.access, { kind: input.kind, commentId: input.commentId }, "eyes");
  if (!reacted.ok) {
    logger?.warn("pr.comment-reaction-failed", { repoId: input.repoId, commentId: input.commentId, code: reacted.error.code });
  }
};

export const acceptPrComment: AcceptPrComment = (deps, input) => acceptPrCommentWith(deps, {}, { ...input, kind: input.path === null ? "issue" : "review" });
