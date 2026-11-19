import type { Logger, RepoAccess } from "@ostra/adapter-sdk";
import { secretRefSchema } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Db } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, repoFullNameSchema, repoIdSchema, sessionIdSchema } from "@ostra/protocol";
import type { RepoId } from "@ostra/protocol";

import type { JobPayload } from "../jobs.ts";
import { taskRepoFromColumns, taskRepoToColumns } from "../lifecycles/mapping.ts";
import { transitionTaskRepo } from "../lifecycles/task-repo.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { writeTicketStepsInTx } from "../tickets/ticket-writes.ts";
import { moveTaskInTx } from "./moves.ts";
import { lastAgentMessageInTx } from "./record-session-end.ts";
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
};

export type OpenPullRequests = (deps: OpenPullRequestsDeps, input: OpenPullRequestsInput) => Promise<OpenPullRequestsResult>;

/** GitHub's limit on a PR title. */
export const PR_TITLE_MAX = 256;

/** The PR's title: the task's title, which for a prompt task comes from its prompt (F-030), kept short. */
export const pullRequestTitle = (title: string): string => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= PR_TITLE_MAX ? line : `${line.slice(0, PR_TITLE_MAX - 3).trimEnd()}...`;
};

/** The PR's body: the agent's text, then a footer that links the task and its other PRs. */
export const pullRequestBody = (text: string, taskUrl: string, others: readonly string[]): string => {
  const footer = [
    "---",
    `Opened by [ostra](${taskUrl}) for this task: ${taskUrl}`,
    ...(others.length === 0 ? [] : ["", "The task's other PRs:", ...others.map((url) => `- ${url}`)]),
  ];
  return `${text.trim()}\n\n${footer.join("\n")}\n`;
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
  const taskRepos = await db.taskRepo.findMany({
    where: { taskId: task.id, ahead: true },
    include: { repo: { include: { connection: true } } },
    orderBy: { createdAt: "asc" },
  });
  const opened: OpenedPullRequest[] = [];
  /** The PRs this run opened, with the agent's text and how many of the task's other PRs they link. */
  const openedHere: { readonly repoId: RepoId; readonly access: RepoAccess; readonly number: number; readonly text: string; readonly linked: number }[] = [];
  for (const taskRepo of taskRepos) {
    const repoId = repoIdSchema.parse(taskRepo.repoId);
    if (taskRepo.state === "pr_open" && taskRepo.prNumber !== null && taskRepo.prUrl !== null) {
      opened.push({ repoId, number: taskRepo.prNumber, url: taskRepo.prUrl, reused: true });
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
    const existing = await deps.adapters.codeHost.findPullRequest(access, taskRepo.branchName);
    if (!existing.ok) {
      return { ok: false, error: "code-host-failed", message: `the code host couldn't be asked for the PR (${existing.error.code})` };
    }
    let pull = existing.value?.state === "open" ? existing.value : null;
    const reused = pull !== null;
    if (pull === null) {
      // The body is the agent's text (untrusted, sent as data), and the footer is ostra's.
      const text = taskRepo.prBody ?? fallbackBody;
      const body = pullRequestBody(text, taskUrl, opened.map((other) => other.url));
      const created = await deps.adapters.codeHost.openPullRequest({
        access,
        head: taskRepo.branchName,
        base: taskRepo.baseBranch,
        title: pullRequestTitle(task.title),
        body,
        draft: false,
      });
      if (!created.ok) {
        return { ok: false, error: "code-host-failed", message: `the code host refused the PR (${created.error.code})` };
      }
      pull = created.value;
      openedHere.push({ repoId, access, number: created.value.number, text, linked: opened.length });
    }
    const pr = pull;
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
      await appendServerEvent(tx, {
        organizationId,
        projectId,
        taskId: task.id,
        sessionId: sessionIdSchema.parse(input.sessionId),
        event: { kind: "pr.opened", repoId, url: pr.url, number: pr.number },
        at: deps.clock.now(),
      });
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
        data: { repoId, number: pr.number, reused },
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
    const updated = await deps.adapters.codeHost.updatePullRequestBody({ access: mine.access, number: mine.number, body: pullRequestBody(mine.text, taskUrl, others) });
    if (!updated.ok) {
      deps.logger?.warn("a PR couldn't link the task's other PRs", { taskId: task.id, repoId: mine.repoId, prNumber: mine.number, code: updated.error.code });
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
