import type { Logger, RepoAccess } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { checksSection, isFailingCheck, withChecksSection } from "../checks/pr-checks.ts";
import type { PrCheck } from "../checks/pr-checks.ts";

import type { JobPayload } from "../jobs.ts";
import { taskRepoFromColumns, taskRepoToColumns } from "../lifecycles/mapping.ts";
import { transitionTaskRepo } from "../lifecycles/task-repo.ts";
import { parseBoardMapping } from "../tickets/board-mapping.ts";
import { ticketMagicLine, ticketPullRequestTitle } from "../tickets/contracts.ts";
import type { JobQueue, Ports } from "../ports.ts";
import { enqueueLinkRelatedInTx } from "../repos/project-repos.ts";
import { enqueueReviewEvaluationInTx } from "../review/review-check.ts";
import type { UseCaseResult } from "./common.ts";
import { writeTicketStepsInTx } from "../tickets/ticket-writes.ts";
import { moveTaskInTx } from "./moves.ts";
import { lastAgentMessageInTx } from "./record-session-end.ts";
import { latestCheckRunsInTx, prChecksFor } from "./checks.ts";
import { repoAccessFor } from "./repo-access.ts";
import { writePullRequestSearchEntry } from "../search/entries.ts";
import { appendServerEvent } from "./server-events.ts";

// F-030, F-078, ADR 0040: the `task.open-pull-requests` job. One PR per changed repo, opened by the
// App: the title from the prompt, the body from the agent's `pr.text_set` (following the repo's PR
// template), with links to the task. Idempotent per task repo: `findPullRequest` first, and the
// idempotency key `task:<TaskId>:open-pr:<RepoId>`. Then a `pr.opened` event per PR, and the task
// moves to in review. Calls the code host, so it takes the client and opens its own transactions
// around each call. Written by ticket 27.
//
// Idempotence: a task repo that is already `pr_open` is skipped, and before opening one the code
// host is asked for an open PR of the branch, which is reused. So the job running twice, or dying
// between the PR's creation and its row's update, opens one PR per repo.

export type OpenPullRequestsInput = JobPayload<"task.open-pull-requests">;

export type OpenedPullRequest = { readonly repoId: RepoId; readonly number: number; readonly url: string; readonly reused: boolean };

export type OpenPullRequestsResult = UseCaseResult<
  { readonly opened: readonly OpenedPullRequest[] },
  "stale" | "not-found" | "code-host-failed"
>;

export type OpenPullRequestsDeps = Pick<Ports, "notices" | "audit" | "clock" | "adapters"> & {
  readonly db: Db;
  /** The panel's address, for the link to the task in each PR's body (OSTRA_PUBLIC_URL). */
  readonly publicUrl: string;
  readonly logger?: Logger;
  /** Called once a PR exists on the code host and before its row says so: the restart harness's seam (ticket 21). */
  readonly afterHostWrite?: () => void;
  /** Milestone 4 (F-104, ticket 18): a PR ostra opens gets its independent-review check evaluated. */
  readonly jobs?: JobQueue;
};

export type OpenPullRequests = (deps: OpenPullRequestsDeps, input: OpenPullRequestsInput) => Promise<OpenPullRequestsResult>;

/** GitHub's limit on a PR title. */
export const PR_TITLE_MAX = 256;

/** The PR's title: the task's title, which for a prompt task comes from its prompt (F-030), kept short. */
export const pullRequestTitle = (title: string): string => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= PR_TITLE_MAX ? line : `${line.slice(0, PR_TITLE_MAX - 3).trimEnd()}...`;
};

/**
 * The PR's body: the agent's text, a ticket task's `Closes <KEY>` (or the board's word, spec
 * section 11, item 5), then a footer that links the task and its other PRs.
 */
export const pullRequestBody = (text: string, taskUrl: string, others: readonly string[], magicLine: string | null = null, checks: string | null = null): string => {
  const footer = [
    "---",
    `Opened by [ostra](${taskUrl}) for this task: ${taskUrl}`,
    ...(others.length === 0 ? [] : ["", "The task's other PRs:", ...others.map((url) => `- ${url}`)]),
  ];
  // Milestone 3 (F-054): the checks section sits between the agent's text and the trailers.
  return `${text.trim()}\n\n${checks === null ? "" : `${checks}\n\n`}${magicLine === null ? "" : `${magicLine}\n\n`}${footer.join("\n")}\n`;
};

/**
 * A ticket task's PR title and magic line (spec section 11, item 5): `<KEY>: <ticket title>` and
 * `Closes <KEY>`, from the ticket as last read and its board's mapping. A prompt task has neither.
 */
const ticketTextOf = async (
  db: Db,
  task: { readonly ticketKey: string | null; readonly ticketId: string | null; readonly boardId: string | null; readonly title: string },
): Promise<{ readonly title: string; readonly magicLine: string } | null> => {
  const key = ticketKeySchema.safeParse(task.ticketKey);
  if (!key.success) {
    return null;
  }
  const ticket = task.ticketId === null ? null : await db.ticket.findUnique({ where: { id: task.ticketId }, select: { title: true, key: true } });
  const board = task.boardId === null ? null : await db.board.findUnique({ where: { id: task.boardId }, select: { statusMap: true } });
  const current = ticketKeySchema.safeParse(ticket?.key);
  const ticketKey = current.success ? current.data : key.data;
  const word = parseBoardMapping(board?.statusMap)?.magicWord ?? "Closes";
  return { title: ticketPullRequestTitle(ticketKey, ticket?.title ?? task.title), magicLine: ticketMagicLine(ticketKey, word) };
};

const M1_ROUNDS = { ci: false, aiReview: false } as const;

export const openPullRequests: OpenPullRequests = async (deps, input) => {
  const { db } = deps;
  const row = await db.task.findFirst({ where: { id: input.taskId, organizationId: input.organizationId } });
  if (row === null) {
    return { ok: false, error: "not-found", message: "no such task" };
  }
  const task = mapTask(row);
  // A member who stopped the task, or a task already reviewed and done, gets no PR now.
  if (task.state !== "running" && task.state !== "in_review") {
    return { ok: false, error: "stale", message: "the task moved on" };
  }
  const organizationId = organizationIdSchema.parse(task.organizationId);
  const projectId = projectIdSchema.parse(task.projectId);
  const taskUrl = `${deps.publicUrl.replace(/\/+$/, "")}/tasks/${task.id}`;
  const fallbackBody = (await db.$transaction((tx) => lastAgentMessageInTx(tx, task.id, input.sessionId))) ?? task.title;
  const ticketText = await ticketTextOf(db, task);
  const taskRepos = await db.taskRepo.findMany({
    where: { taskId: task.id, ahead: true },
    include: { repo: { include: { connection: true } } },
    orderBy: { createdAt: "asc" },
  });
  const opened: OpenedPullRequest[] = [];
  /** The PRs this run opened, with the agent's text and how many of the task's other PRs they link. */
  const openedHere: { readonly repoId: RepoId; readonly access: RepoAccess; readonly number: number; readonly text: string; readonly linked: number; readonly checks: string | null }[] = [];
  // Milestone 3 (F-054, ticket 23): each PR's checks, their latest run, and the drafts they make.
  const latestChecks = await latestCheckRunsInTx(db, task.id);
  const drafts = deps.adapters.codeHost.capabilities.draftPullRequests;
  /** The PRs that were open before this run, for the checks pass below. */
  const existing: ExistingPullRequest[] = [];
  for (const taskRepo of taskRepos) {
    const repoId = repoIdSchema.parse(taskRepo.repoId);
    if (taskRepo.state === "pr_open" && taskRepo.prNumber !== null && taskRepo.prUrl !== null) {
      opened.push({ repoId, number: taskRepo.prNumber, url: taskRepo.prUrl, reused: true });
      existing.push({ taskRepoId: taskRepo.id, repoId, number: taskRepo.prNumber, url: taskRepo.prUrl, branchName: taskRepo.branchName, text: taskRepo.prBody ?? fallbackBody });
      continue;
    }
    const { repo } = taskRepo;
    if (repo.connection.privateKeySecretRef === null) {
      return { ok: false, error: "code-host-failed", message: "the repo's App has no private key" };
    }
    const key = await deps.adapters.secretStore.get(organizationId, secretRefSchema.parse(repo.connection.privateKeySecretRef));
    if (!key.ok) {
      return { ok: false, error: "code-host-failed", message: "the App's private key couldn't be read" };
    }
    const access = {
      app: { appId: repo.connection.appId, privateKey: key.value },
      installationId: repo.installationId,
      repo: repoFullNameSchema.parse(repo.fullName),
    };
    const found = await deps.adapters.codeHost.findPullRequest(access, taskRepo.branchName);
    if (!found.ok) {
      return { ok: false, error: "code-host-failed", message: `the code host couldn't be asked for the PR (${found.error.code})` };
    }
    let pull = found.value?.state === "open" ? found.value : null;
    const reused = pull !== null;
    // A failing check that applies to the repo opens its PR as a draft, which ostra made (F-054).
    const prChecks = prChecksFor(latestChecks, repoId);
    const checks = checksSection(prChecks);
    const draftByOstra = drafts && prChecks.some((check) => isFailingCheck(check.status));
    if (pull === null) {
      // The body is the agent's text (untrusted, sent as data), and the footer is ostra's.
      const text = taskRepo.prBody ?? fallbackBody;
      const body = pullRequestBody(text, taskUrl, opened.map((other) => other.url), ticketText?.magicLine ?? null, checks);
      const created = await deps.adapters.codeHost.openPullRequest({
        access,
        head: taskRepo.branchName,
        base: taskRepo.baseBranch,
        title: ticketText?.title ?? pullRequestTitle(task.title),
        body,
        draft: draftByOstra,
      });
      if (!created.ok) {
        return { ok: false, error: "code-host-failed", message: `the code host refused the PR (${created.error.code})` };
      }
      deps.afterHostWrite?.();
      pull = created.value;
      openedHere.push({ repoId, access, number: created.value.number, text, linked: opened.length, checks });
    } else {
      // A PR of the branch someone opened already: the checks pass below brings it up to date.
      existing.push({ taskRepoId: taskRepo.id, repoId, number: pull.number, url: pull.url, branchName: taskRepo.branchName, text: taskRepo.prBody ?? fallbackBody });
    }
    const pr = pull;
    const prDraft = reused ? (pr.draft ?? false) : draftByOstra;
    await db.$transaction(async (tx) => {
      const state = taskRepoFromColumns(taskRepo);
      const moved = state.ok ? transitionTaskRepo(state.value, { type: "pr_opened", prNumber: pr.number }) : null;
      await tx.taskRepo.update({
        where: { id: taskRepo.id },
        data: {
          prNumber: pr.number,
          prUrl: pr.url,
          ...(moved?.ok === true ? { state: taskRepoToColumns(moved.state).state } : { state: "pr_open" }),
        },
      });
      // Every PR a task repo has had (ADR 0052): the merged and the closed ones stay beside the new.
      await tx.taskPullRequest.upsert({
        where: { taskRepoId_number: { taskRepoId: taskRepo.id, number: pr.number } },
        create: {
          organizationId,
          projectId,
          taskRepoId: taskRepo.id,
          number: pr.number,
          url: pr.url,
          branchName: taskRepo.branchName,
          state: "open",
          draft: prDraft,
          draftByOstra: !reused && draftByOstra,
        },
        update: {},
      });
      const openedSeq = await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId: sessionIdSchema.parse(input.sessionId),
        event: { kind: "pr.opened", repoId, url: pr.url, number: pr.number },
        at: deps.clock.now(),
      });
      // Search (ticket 11): the PR is found by its title, on its repo.
      await writePullRequestSearchEntry(tx, { organizationId, projectId, taskId: task.id, repoId, eventSeq: openedSeq, title: pr.title });
      // Milestone 4 (F-098, ticket 17): the task's PRs link each other in their "Related" sections.
      if (deps.jobs !== undefined && !reused) {
        await enqueueLinkRelatedInTx(deps.jobs, tx, { organizationId, taskId: task.id, repoId, prNumber: pr.number, connectionId: repo.connectionId });
      }
      // Milestone 4 (F-104): the new PR's independent-review check, on its head.
      if (deps.jobs !== undefined && !reused && taskRepo.headSha !== null) {
        await enqueueReviewEvaluationInTx(deps.jobs, tx, { organizationId, taskRepoId: taskRepo.id, prNumber: pr.number, headSha: taskRepo.headSha, connectionId: repo.connectionId });
      }
      // A ticket task's ticket links the PR, moves to in review at the first one, and its
      // progress comment is edited (F-031); each write is keyed, so a rerun writes nothing new.
      await writeTicketStepsInTx({ tx }, { taskId: task.id, trigger: { kind: "pr-opened", repoId, url: pr.url } });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "system", id: null },
        action: "pr.opened",
        entity: "task",
        entityId: task.id,
        data: { repoId, number: pr.number, reused, draft: prDraft },
      });
    });
    opened.push({ repoId, number: pr.number, url: pr.url, reused });
  }

  // A PR opened before the task's later ones links them too, now that they all exist (F-030). Only
  // the PRs this run opened: their body is still ostra's, so nobody's edit is overwritten.
  for (const mine of openedHere) {
    const others = opened.filter((other) => other.repoId !== mine.repoId).map((other) => other.url);
    if (others.length <= mine.linked) {
      continue;
    }
    const updated = await deps.adapters.codeHost.updatePullRequestBody({
      access: mine.access,
      number: mine.number,
      body: pullRequestBody(mine.text, taskUrl, others, ticketText?.magicLine ?? null, mine.checks),
    });
    if (!updated.ok) {
      deps.logger?.warn("a PR couldn't link the task's other PRs", { taskId: task.id, repoId: mine.repoId, prNumber: mine.number, code: updated.error.code });
    }
  }

  // The PRs open before this run: the turn's checks edit their section and their draft state.
  if (existing.length > 0 && latestChecks.length > 0) {
    const changed = await reposChangedInSave(db, task.id, input.eventSeq);
    for (const pr of existing) {
      if (changed !== null && !changed.has(pr.repoId)) {
        continue;
      }
      const updated = await updatePullRequestChecks(deps, {
        organizationId,
        projectId,
        taskId: task.id,
        pr,
        checks: prChecksFor(latestChecks, pr.repoId),
        drafts,
        body: { taskUrl, others: opened.filter((other) => other.repoId !== pr.repoId).map((other) => other.url), magicLine: ticketText?.magicLine ?? null },
      });
      if (!updated.ok) {
        return updated;
      }
    }
  }

  // Every changed repo has its PR: the task is in review, waiting for a reviewer (spec section 4).
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${task.id} FOR UPDATE`;
    const fresh = mapTask(await tx.task.findUniqueOrThrow({ where: { id: task.id } }));
    if (fresh.state === "running") {
      await moveTaskInTx(
        { tx, notices: deps.notices, ...(deps.logger === undefined ? {} : { logger: deps.logger }) },
        fresh,
        { type: "session_ended", withChanges: true, rounds: M1_ROUNDS },
      );
    }
  });
  return { ok: true, opened };
};

/** A PR that was open before the opener ran, which the turn's checks bring up to date. */
type ExistingPullRequest = {
  readonly taskRepoId: string;
  readonly repoId: RepoId;
  readonly number: number;
  readonly url: string;
  readonly branchName: string;
  /** The agent's text, for a body rebuilt when the host doesn't say what it is now. */
  readonly text: string;
};

const savedReposSchema = z.looseObject({ repos: z.array(z.looseObject({ repoId: z.string(), headSha: z.string().nullable() })) });

/**
 * The repos a `session.saved` changed: a head other than the one the task's previous save
 * reported for the repo. `null` when the event isn't a save (milestone 1's session end): then every
 * PR counts as changed. Q188: only a PR changed in the turn is drafted or marked ready by it.
 */
const reposChangedInSave = async (db: Db, taskId: string, eventSeq: number): Promise<ReadonlySet<string> | null> => {
  const event = await db.event.findUnique({ where: { taskId_seq: { taskId, seq: eventSeq } }, select: { kind: true, payload: true } });
  const saved = savedReposSchema.safeParse(event?.payload);
  if (event?.kind !== "session.saved" || !saved.success) {
    return null;
  }
  const before = await db.event.findFirst({ where: { taskId, kind: "session.saved", seq: { lt: eventSeq } }, orderBy: { seq: "desc" }, select: { payload: true } });
  const previous = savedReposSchema.safeParse(before?.payload);
  const heads = new Map((previous.success ? previous.data.repos : []).map((repo) => [repo.repoId, repo.headSha]));
  return new Set(saved.data.repos.filter((repo) => repo.headSha !== null && heads.get(repo.repoId) !== repo.headSha).map((repo) => repo.repoId));
};

/**
 * One open PR after a turn with checks (F-054, ADR 0052): its checks section edited in place (the
 * description as the host has it now, so a person's edits stay; rebuilt from ostra's parts when the
 * host doesn't say), and its draft state. A failing check makes an open PR a draft that ostra
 * made; every check passing marks ready a PR ostra made a draft; a PR a person made a draft stays one.
 */
const updatePullRequestChecks = async (
  deps: OpenPullRequestsDeps,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly pr: ExistingPullRequest;
    readonly checks: readonly PrCheck[];
    readonly drafts: boolean;
    readonly body: { readonly taskUrl: string; readonly others: readonly string[]; readonly magicLine: string | null };
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: "code-host-failed"; readonly message: string }> => {
  const { db } = deps;
  const { pr } = input;
  const access = await repoAccessFor(db, deps.adapters.secretStore, input.organizationId, pr.repoId);
  if (!access.ok) {
    return { ok: false, error: "code-host-failed", message: access.reason };
  }
  const details = await deps.adapters.codeHost.getPullRequest(access.access, pr.number);
  if (!details.ok) {
    return { ok: false, error: "code-host-failed", message: `the code host couldn't read the PR (${details.error.code})` };
  }
  if (details.value.state !== "open") {
    return { ok: true };
  }
  const section = checksSection(input.checks);
  const current = details.value.body;
  const body =
    typeof current === "string"
      ? withChecksSection(current, section, input.body.magicLine)
      : pullRequestBody(pr.text, input.body.taskUrl, input.body.others, input.body.magicLine, section);
  if (body !== current) {
    const edited = await deps.adapters.codeHost.updatePullRequestBody({ access: access.access, number: pr.number, body });
    if (!edited.ok) {
      return { ok: false, error: "code-host-failed", message: `the code host refused the PR's body (${edited.error.code})` };
    }
  }
  const row = await db.taskPullRequest.upsert({
    where: { taskRepoId_number: { taskRepoId: pr.taskRepoId, number: pr.number } },
    create: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskRepoId: pr.taskRepoId,
      number: pr.number,
      url: pr.url,
      branchName: pr.branchName,
      state: "open",
      draft: details.value.draft ?? false,
    },
    update: {},
  });
  if (!input.drafts) {
    return { ok: true };
  }
  const failing = input.checks.some((check) => isFailingCheck(check.status));
  const isDraft = details.value.draft ?? row.draft;
  let next: { readonly draft: boolean; readonly draftByOstra: boolean } | null = null;
  if (failing && !isDraft) {
    next = { draft: true, draftByOstra: true };
  } else if (!failing && isDraft && row.draftByOstra) {
    next = { draft: false, draftByOstra: false };
  } else if (!isDraft && (row.draft || row.draftByOstra)) {
    // A person marked it ready: it's nobody's draft now.
    await db.taskPullRequest.update({ where: { id: row.id }, data: { draft: false, draftByOstra: false } });
  } else if (isDraft && !row.draft) {
    // A person made it a draft: it stays theirs.
    await db.taskPullRequest.update({ where: { id: row.id }, data: { draft: true, draftByOstra: false } });
  }
  if (next === null) {
    return { ok: true };
  }
  const set = await deps.adapters.codeHost.setPullRequestDraft(access.access, pr.number, next.draft);
  if (!set.ok) {
    return { ok: false, error: "code-host-failed", message: `the code host couldn't change the PR's draft state (${set.error.code})` };
  }
  const state = next;
  await db.$transaction(async (tx) => {
    await tx.taskPullRequest.update({ where: { id: row.id }, data: state });
    await deps.audit.recordInTx(tx, {
      organizationId: input.organizationId,
      projectId: input.projectId,
      actor: { kind: "system", id: null },
      action: state.draft ? "pr.made-draft" : "pr.marked-ready",
      entity: "task",
      entityId: input.taskId,
      data: { repoId: pr.repoId, number: pr.number },
    });
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: input.projectId, entity: "task", entityId: input.taskId });
  });
  deps.logger?.info("pr.draft-changed", { taskId: input.taskId, repoId: pr.repoId, prNumber: pr.number, draft: state.draft });
  return { ok: true };
};
