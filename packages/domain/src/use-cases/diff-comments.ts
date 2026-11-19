import { createHash } from "node:crypto";

import type { CompareResult } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { clientMessageIdSchema, diffCommentIdSchema, gitShaSchema, organizationIdSchema, projectIdSchema, repoIdSchema, runnerLimits, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { DiffCommentId, GitSha, OrganizationId, RepoId, TaskId, TaskRepoId } from "@ostra/protocol";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import { commentStillMatches, diffLineAt, parsedFile, readStoredDiff, toStoredDiff } from "../diff/stored-diff.ts";
import type { DiffLimits, StoredDiff } from "../diff/stored-diff.ts";
import { quotedLines } from "../diff/unified-diff.ts";
import { diffCommentsPrompt } from "../prompts/index.ts";
import type { DiffCommentForPrompt } from "../prompts/index.ts";
import type { Ports } from "../ports.ts";
import type { M3Deps, SaveDiffComment, SendDiffComments } from "./m3-signatures.ts";
import { sendMemberMessageInTx } from "./member-message.ts";
import type { SendMemberMessageDeps } from "./member-message.ts";
import { repoAccessFor } from "./repo-access.ts";
import { appendServerEvent } from "./server-events.ts";

// The diff and its comments (F-027, F-072, ADR 0051; ticket 22). The diff is the code host's
// compare of a task repo's base and its pushed head, kept in `DiffCache` by repo and head, so many
// viewers cost one call and a head that hasn't changed is never fetched again. A comment is a
// member's draft until "Send N comments to the agent" sends the member's drafts as one member
// message. Drafts are private to their member; sent comments are every member's. Comment text and
// the diff's code are never logged.

// ---------- the diff ----------

/** Reads the stored diff of a repo's head, whatever base it was compared on. */
export const storedDiffInTx = async (db: Db | Tx, repoId: RepoId, headSha: string): Promise<StoredDiff | null> => {
  const row = await db.diffCache.findFirst({ where: { repoId, headSha }, orderBy: { fetchedAt: "desc" }, select: { result: true } });
  return row === null ? null : readStoredDiff(row.result);
};

export type TaskRepoDiff =
  | { readonly state: "ready"; readonly taskRepoId: TaskRepoId; readonly diff: StoredDiff }
  /** The head's diff isn't fetched yet: `diff.fetch` is queued, and the task's change notice says when it's in. */
  | { readonly state: "loading"; readonly taskRepoId: TaskRepoId; readonly headSha: GitSha }
  /** Nothing pushed yet: there's no diff. */
  | { readonly state: "no-head"; readonly taskRepoId: TaskRepoId };

/**
 * The diffs of a task's repos, for any member who can open its project. A head not fetched yet
 * queues one `diff.fetch` (the queue's key makes many readers one job).
 */
export const taskDiffs = async (
  deps: Pick<M3Deps, "db" | "jobs">,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
): Promise<{ readonly ok: true; readonly repos: readonly TaskRepoDiff[] } | { readonly ok: false; readonly error: "not-found"; readonly message: string }> => {
  const task = await deps.db.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { id: true, projectId: true, organizationId: true } });
  const project = task === null ? null : await deps.db.project.findFirst({ where: { id: task.projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (task === null || project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access }, "read").ok) {
    return { ok: false, error: "not-found", message: "No such task" };
  }
  const repos = await deps.db.taskRepo.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" }, select: { id: true, repoId: true, headSha: true } });
  const out: TaskRepoDiff[] = [];
  for (const repo of repos) {
    const taskRepoId = taskRepoIdSchema.parse(repo.id);
    const head = gitShaSchema.safeParse(repo.headSha);
    if (!head.success) {
      out.push({ state: "no-head", taskRepoId });
      continue;
    }
    const diff = await storedDiffInTx(deps.db, repoIdSchema.parse(repo.repoId), head.data);
    if (diff !== null) {
      out.push({ state: "ready", taskRepoId, diff });
      continue;
    }
    await deps.db.$transaction((tx) =>
      deps.jobs.enqueueInTx(tx, "diff.fetch", {
        organizationId: scope.organizationId,
        taskId: taskIdSchema.parse(task.id),
        repoId: repoIdSchema.parse(repo.repoId),
        baseSha: null,
        headSha: head.data,
      }),
    );
    out.push({ state: "loading", taskRepoId, headSha: head.data });
  }
  return { ok: true, repos: out };
};

export type FetchDiffDeps = Pick<Ports, "notices" | "clock" | "adapters"> & { readonly db: Db; readonly limits: DiffLimits };

export type FetchDiffResult = UseCaseFetch<"fetched" | "cached", "not-found" | "unsupported" | "code-host-failed">;
type UseCaseFetch<O extends string, E extends string> =
  | { readonly ok: true; readonly outcome: O; readonly outdated: number }
  | { readonly ok: false; readonly error: E; readonly message: string; readonly retry: boolean };

/**
 * `diff.fetch`'s body: one compare of the base and the head, stored, unless that head's diff is
 * already in. Then every comment on the task repo written on an older head is checked against it.
 */
export const fetchTaskRepoDiff = async (
  deps: FetchDiffDeps,
  input: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly repoId: RepoId; readonly baseSha: GitSha | null; readonly headSha: GitSha },
): Promise<FetchDiffResult> => {
  const taskRepo = await deps.db.taskRepo.findFirst({
    where: { taskId: input.taskId, repoId: input.repoId, organizationId: input.organizationId },
    select: { id: true, projectId: true, baseBranch: true, prUrl: true },
  });
  if (taskRepo === null) {
    return { ok: false, error: "not-found", message: "no such task repo", retry: false };
  }
  const taskRepoId = taskRepoIdSchema.parse(taskRepo.id);
  const cached = await storedDiffInTx(deps.db, input.repoId, input.headSha);
  let latest = cached;
  let outcome: "fetched" | "cached" = "cached";
  if (latest === null) {
    if (!deps.adapters.codeHost.capabilities.compare) {
      return { ok: false, error: "unsupported", message: `${deps.adapters.codeHost.name} can't compare branches`, retry: false };
    }
    const access = await repoAccessFor(deps.db, deps.adapters.secretStore, input.organizationId, input.repoId);
    if (!access.ok) {
      return { ok: false, error: "code-host-failed", message: access.reason, retry: false };
    }
    const compared = await deps.adapters.codeHost.compare(access.access, input.baseSha ?? taskRepo.baseBranch, input.headSha);
    if (!compared.ok) {
      const retry = compared.error.code !== "not-found" && compared.error.code !== "unsupported";
      return { ok: false, error: "code-host-failed", message: `the code host couldn't compare (${compared.error.code})`, retry };
    }
    latest = storeable(compared.value, input.headSha, taskRepo.prUrl, deps.limits);
    const baseSha = input.baseSha ?? compared.value.mergeBase ?? taskRepo.baseBranch;
    await deps.db.diffCache.upsert({
      where: { repoId_baseSha_headSha: { repoId: input.repoId, baseSha, headSha: input.headSha } },
      create: { organizationId: input.organizationId, projectId: taskRepo.projectId, repoId: input.repoId, baseSha, headSha: input.headSha, result: latest },
      update: { result: latest, fetchedAt: new Date(deps.clock.now()) },
    });
    outcome = "fetched";
  }
  const fresh = latest;
  const outdated = await deps.db.$transaction(async (tx) => {
    const marked = await markOutdatedCommentsInTx(tx, deps.clock.now(), { taskRepoId, repoId: input.repoId, latest: fresh });
    if (outcome === "fetched" || marked > 0) {
      await deps.notices.emitInTx(tx, {
        organizationId: input.organizationId,
        projectId: projectIdSchema.parse(taskRepo.projectId),
        entity: "task",
        entityId: input.taskId,
      });
    }
    return marked;
  });
  return { ok: true, outcome, outdated };
};

const storeable = (compare: CompareResult, headSha: string, prUrl: string | null, limits: DiffLimits): StoredDiff =>
  toStoredDiff(compare, { headSha, hostUrl: prUrl === null ? null : `${prUrl.replace(/\/+$/, "")}/files`, limits });

/**
 * Marks outdated each draft or sent comment on the task repo written on an older head whose line no
 * longer matches in `latest` (F-072). A comment on a line the new head didn't touch keeps matching.
 */
export const markOutdatedCommentsInTx = async (
  tx: Tx,
  now: number,
  input: { readonly taskRepoId: TaskRepoId; readonly repoId: RepoId; readonly latest: StoredDiff },
): Promise<number> => {
  const comments = await tx.diffComment.findMany({
    where: { taskRepoId: input.taskRepoId, state: { in: ["draft", "sent"] }, outdatedAt: null, headSha: { not: input.latest.headSha } },
    select: { id: true, path: true, side: true, line: true, headSha: true },
  });
  const written = new Map<string, StoredDiff | null>();
  const outdated: string[] = [];
  for (const comment of comments) {
    if (!written.has(comment.headSha)) {
      written.set(comment.headSha, await storedDiffInTx(tx, input.repoId, comment.headSha));
    }
    const before = written.get(comment.headSha) ?? null;
    if (before === null || !commentStillMatches(comment, before, input.latest)) {
      outdated.push(comment.id);
    }
  }
  if (outdated.length === 0) {
    return 0;
  }
  const updated = await tx.diffComment.updateMany({ where: { id: { in: outdated }, outdatedAt: null }, data: { outdatedAt: new Date(now) } });
  return updated.count;
};

// ---------- comments ----------

/** A comment as a member reads it: their own drafts and every sent comment, never another's draft. */
export type DiffCommentView = {
  readonly commentId: DiffCommentId;
  readonly taskRepoId: TaskRepoId;
  readonly memberId: string;
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly headSha: string;
  /** The member's text: shown in the panel, never logged. */
  readonly body: string;
  readonly state: "draft" | "sent";
  readonly sentInSeq: number | null;
  readonly outdated: boolean;
};

export const diffCommentsForMember = async (db: Db, scope: MemberScope, input: { readonly taskId: TaskId }): Promise<readonly DiffCommentView[] | null> => {
  const task = await db.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { projectId: true } });
  const project = task === null ? null : await db.project.findFirst({ where: { id: task.projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (project === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(project.id), organizationId: scope.organizationId, access: project.access }, "read").ok) {
    return null;
  }
  const rows = await db.diffComment.findMany({
    where: {
      taskId: input.taskId,
      organizationId: scope.organizationId,
      OR: [{ state: "sent" }, { state: "draft", memberId: scope.memberId }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((row) =>
    row.state === "deleted"
      ? []
      : [
          {
            commentId: diffCommentIdSchema.parse(row.id),
            taskRepoId: taskRepoIdSchema.parse(row.taskRepoId),
            memberId: row.memberId,
            path: row.path,
            side: row.side,
            line: row.line,
            headSha: row.headSha,
            body: row.body,
            state: row.state,
            sentInSeq: row.sentInSeq,
            outdated: row.outdatedAt !== null,
          },
        ],
  );
};

/** The project of a task repo, if the member can open it. */
const taskRepoInScope = async (tx: Tx, scope: MemberScope, taskRepoId: TaskRepoId) => {
  const taskRepo = await tx.taskRepo.findFirst({
    where: { id: taskRepoId, organizationId: scope.organizationId },
    select: { id: true, taskId: true, repoId: true, projectId: true, project: { select: { id: true, access: true } } },
  });
  if (taskRepo === null) {
    return null;
  }
  const access = requireProjectAccess(scope, { id: projectIdSchema.parse(taskRepo.project.id), organizationId: scope.organizationId, access: taskRepo.project.access }, "read");
  return access.ok ? taskRepo : null;
};

export const saveDiffComment: SaveDiffComment = async (deps, scope, input) =>
  deps.db.$transaction(async (tx) => {
    const now = new Date(deps.clock.now());
    if (input.action === "create") {
      const body = input.body.trim();
      if (body === "" || body.length > runnerLimits.diffCommentMaxChars) {
        return { ok: false, error: "too-long", message: `A comment has 1 to ${String(runnerLimits.diffCommentMaxChars)} characters` };
      }
      const taskRepo = await taskRepoInScope(tx, scope, input.taskRepoId);
      if (taskRepo === null) {
        return { ok: false, error: "not-found", message: "No such repo of the task" };
      }
      const diff = await storedDiffInTx(tx, repoIdSchema.parse(taskRepo.repoId), input.headSha);
      if (diff === null || diffLineAt(diff, input.path, input.side, input.line) === null) {
        return { ok: false, error: "no-such-line", message: "That line isn't in the diff of that head" };
      }
      const created = await tx.diffComment.create({
        data: {
          organizationId: scope.organizationId,
          projectId: taskRepo.projectId,
          taskId: taskRepo.taskId,
          taskRepoId: taskRepo.id,
          memberId: scope.memberId,
          path: input.path,
          side: input.side,
          line: input.line,
          headSha: input.headSha,
          body,
        },
        select: { id: true },
      });
      return { ok: true, commentId: diffCommentIdSchema.parse(created.id) };
    }
    const comment = await tx.diffComment.findFirst({ where: { id: input.commentId, organizationId: scope.organizationId } });
    const inScope = comment === null ? null : await taskRepoInScope(tx, scope, taskRepoIdSchema.parse(comment.taskRepoId));
    // Another member's draft is private: it doesn't exist for anyone else.
    if (comment === null || inScope === null || comment.state === "deleted" || (comment.state === "draft" && comment.memberId !== scope.memberId)) {
      return { ok: false, error: "not-found", message: "No such comment" };
    }
    if (comment.memberId !== scope.memberId) {
      return { ok: false, error: "not-yours", message: "That comment is another member's" };
    }
    if (comment.state === "sent") {
      return { ok: false, error: "sent", message: "A sent comment can't be changed" };
    }
    if (input.action === "edit") {
      const body = input.body.trim();
      if (body === "" || body.length > runnerLimits.diffCommentMaxChars) {
        return { ok: false, error: "too-long", message: `A comment has 1 to ${String(runnerLimits.diffCommentMaxChars)} characters` };
      }
      await tx.diffComment.update({ where: { id: comment.id }, data: { body, updatedAt: now } });
    } else {
      await tx.diffComment.update({ where: { id: comment.id }, data: { state: "deleted", updatedAt: now } });
    }
    return { ok: true, commentId: diffCommentIdSchema.parse(comment.id) };
  });

/** The send's message ID: fixed by the drafts it carries, so a retried send is the same message. */
const diffCommentsMessageId = (ids: readonly string[]) =>
  clientMessageIdSchema.parse(`diff-comments:${createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 32)}`);

/** Renders the comments, shortening each one's text until the message fits a steer. */
const renderDiffComments = (comments: readonly DiffCommentForPrompt[]): string => {
  let cap: number = runnerLimits.diffCommentMaxChars;
  let text = diffCommentsPrompt(comments);
  while (text.length > runnerLimits.steerTextMaxChars && cap > 200) {
    cap = Math.floor(cap / 2);
    const limit = cap;
    text = diffCommentsPrompt(comments.map((comment) => ({ ...comment, body: comment.body.slice(0, limit), quoted: comment.quoted.slice(0, limit) })));
  }
  return text;
};

/** The ports and settings a send needs beyond `M3Deps`: the composer's caps and timers. */
export type SendDiffCommentsExtras = Pick<SendMemberMessageDeps, "spendCap" | "timers">;

export const sendDiffComments: SendDiffComments = async (deps, scope, input) => sendDiffCommentsWith(deps, {}, scope, input);

/** `sendDiffComments`, with the server's spend cap and session timers for a reopen. */
export const sendDiffCommentsWith = (
  deps: M3Deps,
  extras: SendDiffCommentsExtras,
  scope: MemberScope,
  input: { readonly taskId: TaskId },
): ReturnType<SendDiffComments> =>
  deps.db.$transaction(
    async (tx) => {
      // The task's lock first: two sends of the same drafts take turns, and the second finds none.
      const locked = await tx.$queryRaw<readonly unknown[]>`
        SELECT 1 FROM "task" WHERE "id" = ${input.taskId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
      const task = locked.length === 0 ? null : await tx.task.findUnique({ where: { id: input.taskId }, select: { id: true, projectId: true, project: { select: { access: true } } } });
      if (task === null || !requireProjectAccess(scope, { id: projectIdSchema.parse(task.projectId), organizationId: scope.organizationId, access: task.project.access }, "read").ok) {
        return { ok: false, error: "not-found", message: "No such task" };
      }
      const drafts = await tx.diffComment.findMany({
        where: { taskId: task.id, memberId: scope.memberId, state: "draft" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { taskRepo: { select: { repoId: true, repo: { select: { fullName: true } } } } },
      });
      if (drafts.length === 0) {
        return { ok: false, error: "no-drafts", message: "There are no comments to send" };
      }
      if (drafts.length > runnerLimits.diffCommentsPerSendMax) {
        return { ok: false, error: "too-many", message: `At most ${String(runnerLimits.diffCommentsPerSendMax)} comments go in one send` };
      }
      const diffs = new Map<string, StoredDiff | null>();
      const forPrompt: DiffCommentForPrompt[] = [];
      for (const draft of drafts) {
        const key = `${draft.taskRepo.repoId}:${draft.headSha}`;
        if (!diffs.has(key)) {
          diffs.set(key, await storedDiffInTx(tx, repoIdSchema.parse(draft.taskRepo.repoId), draft.headSha));
        }
        const diff = diffs.get(key) ?? null;
        const parsed = diff === null ? null : parsedFile(diff, draft.path);
        forPrompt.push({
          repo: draft.taskRepo.repo.fullName,
          path: draft.path,
          side: draft.side,
          line: draft.line,
          quoted: parsed === null ? "" : quotedLines(parsed, draft.side, draft.line),
          body: draft.body,
        });
      }
      const ids = drafts.map((draft) => draft.id);
      const clientMessageId = diffCommentsMessageId(ids);
      const sent = await sendMemberMessageInTx({ ...deps, ...extras }, tx, scope, {
        taskId: input.taskId,
        clientMessageId,
        text: renderDiffComments(forPrompt),
        intent: "diff-comments",
        sender: "driver",
      });
      if (!sent.ok) {
        return { ok: false, error: sent.error, message: sent.message };
      }
      const message = await tx.event.findFirst({
        where: { taskId: task.id, kind: "user.message", payload: { path: ["clientMessageId"], equals: clientMessageId } },
        select: { seq: true },
      });
      await tx.diffComment.updateMany({ where: { id: { in: ids }, state: "draft" }, data: { state: "sent", sentInSeq: message?.seq ?? null } });
      await appendServerEvent(tx, {
        organizationId: organizationIdSchema.parse(scope.organizationId),
        projectId: projectIdSchema.parse(task.projectId),
        taskId: input.taskId,
        sessionId: sent.sessionId,
        at: deps.clock.now(),
        event: { kind: "diff.comments_sent", commentIds: ids.map((id) => diffCommentIdSchema.parse(id)), count: ids.length },
      });
      await deps.audit.recordInTx(tx, {
        organizationId: scope.organizationId,
        projectId: projectIdSchema.parse(task.projectId),
        actor: { kind: "member", id: scope.memberId },
        action: "diff.comments-sent",
        entity: "task",
        entityId: input.taskId,
        data: { count: ids.length, delivery: sent.delivery },
      });
      return { ok: true, sent: ids.length, delivery: sent.delivery, seq: message?.seq ?? null };
    },
    { timeout: 20_000 },
  );
