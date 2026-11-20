import type { Logger, PullRequestReview, RequestedReviewers } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { memberIdSchema, needsYouItemIdSchema, organizationIdSchema, projectIdSchema, repoIdSchema, sessionIdSchema, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, TaskRepoId } from "@ostra/protocol";

import { reviewersRefreshSingletonSeconds } from "../jobs.ts";
import type { ChangeNotices, Clock, JobQueue, ServerAdapters } from "../ports.ts";
import { resolveNeedsYouItemsInTx } from "../use-cases/needs-you-items.ts";
import { repoAccessFor } from "../use-cases/repo-access.ts";
import { appendServerEvent } from "../use-cases/server-events.ts";
import type { RefreshReviewers } from "../use-cases/m6-signatures.ts";
import { ownersFor, parseCodeOwners } from "./codeowners.ts";

// A task PR's reviewers (F-102, F-036, ADR 0058, ADR 0050; milestone 6's ticket 19). ostra reads who
// the repo says reviews, and requests nobody on GitHub:
// - `reviewers.refresh`, keyed by the task repo (a 10-second window), on a `review_requested` or
//   `review_request_removed`, a PR's opening, a push and the reconcile: the PR's requested users and
//   teams (`listRequestedReviewers`), and the owners `CODEOWNERS` names at the PR's base for the
//   paths the PR changes (`readCodeOwners`, `ownersFor`). Each GitHub user is matched to an active
//   member through the verified link (F-119); a team is a row of its own, never expanded, with no
//   member; an unlinked user is listed with no member. `TaskReviewer` keeps the set, and
//   `reviewers.updated` goes in the thread when it changes.
// - A user's latest review state is kept from milestone 4's review handling (`review.evaluate`
//   reads every review), so a reviewer GitHub no longer lists as requested once they reviewed stays
//   on the task with their state.
// - The audience: a code task waiting for a reviewer has one needs-you item (`waiting_for_reviewer`,
//   audience `reviewer`, the moment `review_requested`), for the matched reviewers who can open the
//   project, or the driver when nobody is matched (`reviewerMembersInTx`). A reviewer whose review
//   comes in clears their own notification; the item is answered once every one of them reviewed.
// Logins and IDs reach the logs; a CODEOWNERS file's text never does.

/** A `CODEOWNERS` user with no GitHub user ID to key by (an unlinked login): `login:<login>`. */
export const codeOwnerLoginKey = (login: string): string => `login:${login.toLowerCase()}`;

/** A row `refreshReviewers` wants on the task repo. */
type WantedReviewer =
  | { readonly kind: "user"; readonly githubUserId: string; readonly login: string; readonly source: "requested" | "codeowners" }
  | { readonly kind: "team"; readonly teamSlug: string };

/** A team's slug as ostra keeps it: GitHub's slug in small letters, without the organization's prefix. */
export const teamSlugOf = (name: string): string => (name.split("/").at(-1) ?? name).toLowerCase();

/**
 * The reviewers a PR's requested reviewers and its code owners make, each once: a requested user
 * by their ID; a code owner by the requested user of the same login, else the linked account's ID,
 * else their login (`codeOwnerLoginKey`); a team by its slug. A requested user who is also a code
 * owner counts as requested. Pure.
 */
export const wantedReviewers = (
  requested: RequestedReviewers,
  owners: { readonly users: readonly string[]; readonly teams: readonly string[] },
  linkedLogins: ReadonlyMap<string, string>,
): readonly WantedReviewer[] => {
  const wanted: WantedReviewer[] = [];
  const users = new Set<string>();
  const logins = new Map<string, string>();
  for (const user of requested.users) {
    if (users.has(user.userId)) continue;
    users.add(user.userId);
    logins.set(user.login.toLowerCase(), user.userId);
    wanted.push({ kind: "user", githubUserId: user.userId, login: user.login, source: "requested" });
  }
  for (const login of owners.users) {
    const lower = login.toLowerCase();
    const githubUserId = logins.get(lower) ?? linkedLogins.get(lower) ?? codeOwnerLoginKey(login);
    if (users.has(githubUserId)) continue;
    users.add(githubUserId);
    logins.set(lower, githubUserId);
    wanted.push({ kind: "user", githubUserId, login, source: "codeowners" });
  }
  const teams = new Set<string>();
  for (const name of [...requested.teams.map((team) => team.slug), ...owners.teams]) {
    const slug = teamSlugOf(name);
    if (slug === "" || teams.has(slug)) continue;
    teams.add(slug);
    wanted.push({ kind: "team", teamSlug: slug });
  }
  return wanted;
};

export type ReviewersDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly logger?: Logger;
};

export type RefreshReviewersResult = Awaited<ReturnType<RefreshReviewers>> & {
  /** Whether the set changed, so `reviewers.updated` was written. */
  readonly changed: boolean;
};

const NOTHING: RefreshReviewersResult = { matched: 0, unmatched: 0, teams: 0, changed: false };

/** The rows' set, for "did it change": each user by ID with their member, each team by slug. */
const setKey = (rows: readonly { readonly githubUserId: string | null; readonly teamSlug: string | null; readonly memberId: string | null }[]): string =>
  rows
    .map((row) => (row.teamSlug !== null ? `team:${row.teamSlug}` : `user:${row.githubUserId ?? ""}:${row.memberId ?? ""}`))
    .sort()
    .join("\n");

/**
 * Reads a task PR's reviewers on the host and keeps them in `TaskReviewer`. A code host failure
 * throws, so the job retries; a host with neither `requestedReviewers` nor `codeOwners` reads
 * nothing (optional capabilities, ADR 0025).
 */
export const refreshReviewers = async (deps: ReviewersDeps, input: { readonly organizationId: OrganizationId; readonly taskRepoId: TaskRepoId }): Promise<RefreshReviewersResult> => {
  const { db } = deps;
  const { codeHost } = deps.adapters;
  const taskRepo = await db.taskRepo.findFirst({
    where: { id: input.taskRepoId, organizationId: input.organizationId },
    select: { id: true, taskId: true, projectId: true, repoId: true, state: true, prNumber: true, headSha: true, baseBranch: true, task: { select: { kind: true } } },
  });
  if (taskRepo?.state !== "pr_open" || taskRepo.prNumber === null || taskRepo.task.kind !== "code") {
    return NOTHING;
  }
  if (!codeHost.capabilities.requestedReviewers && !codeHost.capabilities.codeOwners) {
    return NOTHING;
  }
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const repoId = repoIdSchema.parse(taskRepo.repoId);
  const access = await repoAccessFor(db, deps.adapters.secretStore, organizationId, repoId);
  if (!access.ok) {
    throw new Error(`reviewers.refresh: ${access.reason}`);
  }
  let requested: RequestedReviewers = { users: [], teams: [] };
  if (codeHost.capabilities.requestedReviewers) {
    const listed = await codeHost.listRequestedReviewers(access.access, taskRepo.prNumber);
    if (!listed.ok) {
      throw new Error(`reviewers.refresh: the code host couldn't list the requested reviewers (${listed.error.code})`);
    }
    requested = listed.value;
  }
  let owners: { readonly users: readonly string[]; readonly teams: readonly string[] } = { users: [], teams: [] };
  if (codeHost.capabilities.codeOwners) {
    const text = await codeHost.readCodeOwners(access.access, taskRepo.baseBranch);
    if (!text.ok) {
      throw new Error(`reviewers.refresh: the code host couldn't read CODEOWNERS (${text.error.code})`);
    }
    if (text.value !== null && taskRepo.headSha !== null && codeHost.capabilities.compare) {
      // The paths the PR changes, from its base to its head; a rename counts for both of its paths.
      const compared = await codeHost.compare(access.access, taskRepo.baseBranch, taskRepo.headSha);
      if (!compared.ok) {
        throw new Error(`reviewers.refresh: the code host couldn't compare the PR (${compared.error.code})`);
      }
      const paths = compared.value.files.flatMap((file) => (file.previousPath === null ? [file.path] : [file.path, file.previousPath]));
      owners = ownersFor(parseCodeOwners(text.value), paths);
    }
  }

  // Each GitHub user by the verified link (F-119) to the organization's active member.
  const members = await db.member.findMany({
    where: { organizationId, state: "active", user: { githubUserId: { not: null } } },
    select: { id: true, user: { select: { githubUserId: true, githubLogin: true } } },
  });
  const memberOfUser = new Map<string, MemberId>();
  const linkedLogins = new Map<string, string>();
  for (const member of members) {
    const { githubUserId, githubLogin } = member.user;
    if (githubUserId === null) continue;
    memberOfUser.set(githubUserId, memberIdSchema.parse(member.id));
    if (githubLogin !== null) linkedLogins.set(githubLogin.toLowerCase(), githubUserId);
  }
  const wanted = wantedReviewers(requested, owners, linkedLogins);
  const now = deps.clock.now();
  const projectId = projectIdSchema.parse(taskRepo.projectId);
  const taskId = taskIdSchema.parse(taskRepo.taskId);
  const prNumber = taskRepo.prNumber;

  const result = await db.$transaction(
    async (tx): Promise<RefreshReviewersResult> => {
      await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${taskId} FOR UPDATE`;
      const before = await tx.taskReviewer.findMany({ where: { taskRepoId: taskRepo.id }, select: { id: true, githubUserId: true, teamSlug: true, memberId: true, lastReviewState: true } });
      const wantedUsers = new Set(wanted.flatMap((row) => (row.kind === "user" ? [row.githubUserId] : [])));
      const wantedTeams = new Set(wanted.flatMap((row) => (row.kind === "team" ? [row.teamSlug] : [])));
      // A row that's no longer asked for goes, unless its user reviewed: GitHub drops a reviewer's
      // request when their review is submitted, and the review still counts.
      const gone = before.filter((row) =>
        row.teamSlug !== null ? !wantedTeams.has(row.teamSlug) : row.githubUserId !== null && !wantedUsers.has(row.githubUserId) && row.lastReviewState === null,
      );
      if (gone.length > 0) {
        await tx.taskReviewer.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } });
      }
      for (const row of wanted) {
        if (row.kind === "team") {
          await tx.taskReviewer.upsert({
            where: { taskRepoId_teamSlug: { taskRepoId: taskRepo.id, teamSlug: row.teamSlug } },
            create: { organizationId, projectId, taskRepoId: taskRepo.id, teamSlug: row.teamSlug, source: "team" },
            update: {},
          });
          continue;
        }
        const memberId = memberOfUser.get(row.githubUserId) ?? null;
        await tx.taskReviewer.upsert({
          where: { taskRepoId_githubUserId: { taskRepoId: taskRepo.id, githubUserId: row.githubUserId } },
          create: { organizationId, projectId, taskRepoId: taskRepo.id, githubUserId: row.githubUserId, login: row.login.slice(0, 100), memberId, source: row.source },
          update: { login: row.login.slice(0, 100), memberId, source: row.source },
        });
      }
      const after = await tx.taskReviewer.findMany({ where: { taskRepoId: taskRepo.id }, orderBy: { id: "asc" }, select: { githubUserId: true, teamSlug: true, memberId: true, login: true } });
      const counts = {
        matched: after.filter((row) => row.teamSlug === null && row.memberId !== null).length,
        unmatched: after.filter((row) => row.teamSlug === null && row.memberId === null).length,
        teams: after.filter((row) => row.teamSlug !== null).length,
      };
      if (setKey(before) === setKey(after)) {
        return { ...counts, changed: false };
      }
      const session = await tx.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (session !== null) {
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId,
          sessionId: sessionIdSchema.parse(session.id),
          at: now,
          event: {
            kind: "reviewers.updated",
            repoId,
            prNumber,
            memberIds: [...new Set(after.flatMap((row) => (row.memberId === null ? [] : [memberIdSchema.parse(row.memberId)])))].slice(0, 100),
            logins: after.flatMap((row) => (row.login === null ? [] : [row.login.slice(0, 100)])).slice(0, 100),
          },
        });
      }
      // A task already waiting for a reviewer tells the new ones: the fan-out writes only what's missing.
      const waiting = await tx.needsYouItem.findFirst({ where: { taskId, reason: "waiting_for_reviewer", state: "open" }, select: { id: true } });
      if (waiting !== null) {
        await deps.jobs.enqueueInTx(tx, "notify.fanout", { organizationId, needsYouItemId: needsYouItemIdSchema.parse(waiting.id), notificationId: null, change: "created" });
      }
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
      return { ...counts, changed: true };
    },
    { timeout: 20_000 },
  );
  deps.logger?.info("reviewers.refreshed", { taskId, taskRepoId: taskRepo.id, prNumber, matched: result.matched, unmatched: result.unmatched, teams: result.teams, changed: result.changed });
  return result;
};

/** One `reviewers.refresh` for a task repo, after the window that lets events a moment apart refresh once. */
export const enqueueReviewersRefreshInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: string; readonly connectionId: string },
): Promise<void> => {
  await jobs.enqueueInTx(
    tx,
    "reviewers.refresh",
    { organizationId: input.organizationId, taskRepoId: taskRepoIdSchema.parse(input.taskRepoId) },
    { startAfterMs: reviewersRefreshSingletonSeconds * 1000, group: { id: input.connectionId } },
  );
};

/**
 * A `pull_request` `review_requested` or `review_request_removed` hint: a refresh of the task
 * repo whose PR it is. `false` when it's no task's open PR.
 */
export const enqueueReviewersForHintInTx = async (
  jobs: JobQueue,
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly connectionId: string; readonly hostRepoId: string; readonly prNumber: number },
): Promise<boolean> => {
  const row = await tx.taskRepo.findFirst({
    where: { organizationId: input.organizationId, state: "pr_open", prNumber: input.prNumber, repo: { connectionId: input.connectionId, hostRepoId: input.hostRepoId }, task: { kind: "code" } },
    select: { id: true },
  });
  if (row === null) {
    return false;
  }
  await enqueueReviewersRefreshInTx(jobs, tx, { organizationId: input.organizationId, taskRepoId: row.id, connectionId: input.connectionId });
  return true;
};

// ---------- the audience (F-036, ADR 0050) ----------

/**
 * The members a code task's reviewer item reaches: its PRs' matched reviewers (a user linked to an
 * active member), each once. Empty when nobody is matched, and the resolver falls back to the driver.
 */
export const reviewerMembersInTx = async (tx: Pick<Tx, "taskReviewer">, taskId: string): Promise<readonly MemberId[]> => {
  const rows = await tx.taskReviewer.findMany({ where: { taskRepo: { taskId }, memberId: { not: null }, teamSlug: null }, orderBy: { id: "asc" }, select: { memberId: true } });
  return [...new Set(rows.flatMap((row) => (row.memberId === null ? [] : [memberIdSchema.parse(row.memberId)])))];
};

/** The latest submitted review of each user, as `listReviews` gives them oldest first. A pending review counts for nothing. */
const latestByUser = (reviews: readonly PullRequestReview[]): ReadonlyMap<string, PullRequestReview> => {
  const latest = new Map<string, PullRequestReview>();
  for (const review of reviews) {
    if (review.state === "pending" || review.submittedAt === null) continue;
    const seen = latest.get(review.userId);
    // A review in the map was submitted: only those go in.
    if (seen === undefined || (seen.submittedAt ?? 0) <= review.submittedAt) {
      latest.set(review.userId, review);
    }
  }
  return latest;
};

/**
 * A task PR's reviews, as milestone 4's `review.evaluate` reads them: each reviewer's latest state
 * kept on their `TaskReviewer` row (made for a user who reviewed without being asked, so the
 * review still counts), and each matched reviewer whose review came in after the task started
 * waiting for a reviewer has their own notification of it answered. Once every matched reviewer's
 * notification is closed, the item is answered. Returns the members it cleared.
 */
export const recordReviewerStatesInTx = async (
  deps: { readonly jobs: JobQueue; readonly notices: ChangeNotices },
  tx: Tx,
  input: { readonly organizationId: OrganizationId; readonly taskRepoId: string; readonly reviews: readonly PullRequestReview[]; readonly now: number },
): Promise<readonly MemberId[]> => {
  const taskRepo = await tx.taskRepo.findUnique({ where: { id: input.taskRepoId }, select: { id: true, taskId: true, projectId: true } });
  if (taskRepo === null) {
    return [];
  }
  const latest = latestByUser(input.reviews);
  if (latest.size === 0) {
    return [];
  }
  const users = [...latest.keys()];
  const members = await tx.member.findMany({ where: { organizationId: input.organizationId, state: "active", user: { githubUserId: { in: users } } }, select: { id: true, user: { select: { githubUserId: true } } } });
  const memberOfUser = new Map(members.flatMap((member) => (member.user.githubUserId === null ? [] : [[member.user.githubUserId, member.id] as const])));
  for (const review of latest.values()) {
    if (review.isBot) continue;
    const memberId = memberOfUser.get(review.userId) ?? null;
    await tx.taskReviewer.upsert({
      where: { taskRepoId_githubUserId: { taskRepoId: taskRepo.id, githubUserId: review.userId } },
      create: { organizationId: input.organizationId, projectId: taskRepo.projectId, taskRepoId: taskRepo.id, githubUserId: review.userId, login: review.login.slice(0, 100), memberId, source: "requested", lastReviewState: review.state },
      update: { lastReviewState: review.state, memberId },
    });
  }
  const item = await tx.needsYouItem.findFirst({ where: { taskId: taskRepo.taskId, reason: "waiting_for_reviewer", state: "open" }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
  if (item === null) {
    return [];
  }
  // A review since the task started waiting: the reviewer's own notification of it is answered.
  const reviewedSince = [...latest.values()].filter((review) => !review.isBot && (review.submittedAt ?? 0) >= item.createdAt.getTime());
  const cleared = [...new Set(reviewedSince.flatMap((review) => {
    const memberId = memberOfUser.get(review.userId);
    return memberId === undefined ? [] : [memberIdSchema.parse(memberId)];
  }))];
  if (cleared.length === 0) {
    return [];
  }
  const closing = await tx.notification.findMany({ where: { needsYouItemId: item.id, memberId: { in: [...cleared] }, state: "open" }, select: { id: true, memberId: true } });
  if (closing.length > 0) {
    await tx.notification.updateMany({ where: { id: { in: closing.map((row) => row.id) }, state: "open" }, data: { state: "answered" } });
    for (const row of closing) {
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "member", entityId: memberIdSchema.parse(row.memberId) });
    }
  }
  // Every matched reviewer reviewed: the item is answered, by the last of them.
  const audience = await reviewerMembersInTx(tx, taskRepo.taskId);
  const closed = new Set(
    (await tx.notification.findMany({ where: { needsYouItemId: item.id, memberId: { in: [...audience] }, state: { not: "open" } }, select: { memberId: true } })).map((row) => row.memberId),
  );
  if (audience.length > 0 && audience.every((memberId) => closed.has(memberId) || cleared.includes(memberId))) {
    await resolveNeedsYouItemsInTx(deps, tx, { id: item.id }, { state: "answered", at: new Date(input.now), byMemberId: cleared.at(-1) ?? null });
  }
  await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: projectIdSchema.parse(taskRepo.projectId), entity: "task", entityId: taskIdSchema.parse(taskRepo.taskId) });
  return cleared;
};
