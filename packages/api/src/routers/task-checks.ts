import { checkRunStatusFromDb } from "@ostra/db";
import { isFailingCheck } from "@ostra/domain";
import { checkIdSchema, checkStatusSchema, repoIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";

// F-054, F-070 (ticket 39; ADR 0052): the Checks tab's data. Each turn that changed code has its
// checks' runs, with the end of each output, the commit they ran on, and a link to the full output
// the web app serves after the access check. The task's PRs follow, with whether a failed check made
// one a draft. Output is untrusted text: returned as data, never interpreted, never logged.

const finishedPayload = z.looseObject({ checkId: z.string(), outputTail: z.string() });
const savedPayload = z.looseObject({
  turnOrdinal: z.number().int(),
  repos: z.array(z.looseObject({ repoId: z.string(), headSha: z.string().nullable() })),
});

/** Where a check's full output is served: the web app's route, after it checks the caller may see the task. */
export const checkOutputPath = (taskId: string, checkRunId: string): string => `/api/tasks/${taskId}/checks/${checkRunId}/output`;

export const loadChecksView = async (deps: ApiDeps, task: { readonly id: TaskId; readonly organizationId: OrganizationId; readonly projectId: string }) => {
  const { db } = deps;
  const { organizationId } = task;
  const [runs, finished, saved, definitions, taskRepos, turns, lease] = await Promise.all([
    db.checkRun.findMany({ where: { taskId: task.id, organizationId }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "check.finished" }, orderBy: { seq: "asc" }, take: 5_000, select: { sessionId: true, payload: true } }),
    db.event.findMany({ where: { taskId: task.id, organizationId, kind: "session.saved" }, orderBy: { seq: "asc" }, take: 2_000, select: { sessionId: true, payload: true } }),
    db.check.findMany({ where: { projectId: task.projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    db.taskRepo.findMany({
      where: { taskId: task.id, organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, repoId: true, repo: { select: { fullName: true } }, pullRequests: { orderBy: { openedAt: "desc" } } },
    }),
    db.turn.findMany({ where: { taskId: task.id, organizationId }, orderBy: [{ startSeq: "asc" }], select: { sessionId: true, ordinal: true } }),
    db.lease.findFirst({ where: { taskId: task.id, organizationId, state: "active" }, select: { runnerId: true } }),
  ]);
  const presence = lease === null ? null : await db.runnerPresence.findUnique({ where: { runnerId: lease.runnerId }, select: { minor: true } });

  const commandOf = new Map(definitions.map((check) => [check.id, check.command]));
  const repoName = new Map(taskRepos.map((row) => [row.repoId, row.repo.fullName]));

  // A run's output tail is in its `check.finished` event: the n-th finish of a check in a session
  // is the n-th finished run of that check there.
  const finishedBy = new Map<string, string[]>();
  for (const row of finished) {
    const parsed = finishedPayload.safeParse(row.payload);
    if (parsed.success) {
      const key = `${row.sessionId}:${parsed.data.checkId}`;
      finishedBy.set(key, [...(finishedBy.get(key) ?? []), parsed.data.outputTail]);
    }
  }
  const runsOfCheck = new Map<string, typeof runs>();
  for (const run of runs) {
    if (run.status !== "running") {
      const key = `${run.sessionId}:${run.checkId}`;
      runsOfCheck.set(key, [...(runsOfCheck.get(key) ?? []), run].sort((a, b) => a.turnOrdinal - b.turnOrdinal));
    }
  }
  const tailOf = (run: (typeof runs)[number]): string | null => {
    const key = `${run.sessionId}:${run.checkId}`;
    const index = (runsOfCheck.get(key) ?? []).findIndex((candidate) => candidate.id === run.id);
    return index < 0 ? null : (finishedBy.get(key)?.[index] ?? null);
  };

  // The commit each turn's checks ran on, from the push that followed them.
  const headsOf = new Map<string, { repoId: string; headSha: string }[]>();
  for (const row of saved) {
    const parsed = savedPayload.safeParse(row.payload);
    if (parsed.success) {
      headsOf.set(
        `${row.sessionId}:${String(parsed.data.turnOrdinal)}`,
        parsed.data.repos.flatMap((repo) => (repo.headSha === null ? [] : [{ repoId: repo.repoId, headSha: repo.headSha }])),
      );
    }
  }

  // "Turn n" counts across the task's sessions: the turns of earlier sessions come first.
  const turnsBefore = new Map<string, number>();
  {
    const perSession = new Map<string, number>();
    for (const turn of turns) {
      perSession.set(turn.sessionId, (perSession.get(turn.sessionId) ?? 0) + 1);
    }
    let seen = 0;
    for (const [sessionId, count] of perSession) {
      turnsBefore.set(sessionId, seen);
      seen += count;
    }
  }

  const groups = new Map<string, { sessionId: string; turnOrdinal: number; runs: typeof runs }>();
  for (const run of runs) {
    const key = `${run.sessionId}:${String(run.turnOrdinal)}`;
    const group = groups.get(key) ?? { sessionId: run.sessionId, turnOrdinal: run.turnOrdinal, runs: [] };
    groups.set(key, { ...group, runs: [...group.runs, run] });
  }
  const orderOf = (id: string): number => {
    const index = definitions.findIndex((check) => check.id === id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const views = [...groups.values()].map((group) => {
    const key = `${group.sessionId}:${String(group.turnOrdinal)}`;
    const ordered = [...group.runs].sort((a, b) => orderOf(a.checkId) - orderOf(b.checkId) || a.startedAt.getTime() - b.startedAt.getTime());
    const statuses = ordered.map((run) => checkStatusSchema.safeParse(checkRunStatusFromDb[run.status]));
    const running = ordered.some((run) => run.status === "running");
    return {
      sessionId: group.sessionId,
      turnOrdinal: group.turnOrdinal,
      /** The turn's number across the task's sessions. */
      turnNumber: (turnsBefore.get(group.sessionId) ?? 0) + group.turnOrdinal,
      startedAt: Math.min(...ordered.map((run) => run.startedAt.getTime())),
      finishedAt: running ? null : Math.max(...ordered.map((run) => run.finishedAt?.getTime() ?? run.startedAt.getTime())),
      running,
      /** The commits the checks ran on, per repo, from the push after the turn. */
      heads: (headsOf.get(key) ?? []).map((head) => ({ repoId: repoIdSchema.parse(head.repoId), repo: repoName.get(head.repoId) ?? "", headSha: head.headSha })),
      totalMs: ordered.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
      counts: {
        passed: statuses.filter((status) => status.success && status.data === "passed").length,
        failed: statuses.filter((status) => status.success && status.data === "failed").length,
        timedOut: statuses.filter((status) => status.success && status.data === "timed-out").length,
        error: statuses.filter((status) => status.success && status.data === "error").length,
        running: ordered.filter((run) => run.status === "running").length,
      },
      runs: ordered.map((run) => {
        const status = checkRunStatusFromDb[run.status];
        return {
          id: run.id,
          checkId: checkIdSchema.parse(run.checkId),
          name: run.name,
          /** `null` when the check was deleted since. */
          command: commandOf.get(run.checkId) ?? null,
          repoId: run.repoId === null ? null : repoIdSchema.parse(run.repoId),
          repo: run.repoId === null ? null : (repoName.get(run.repoId) ?? null),
          status,
          exitCode: run.exitCode,
          durationMs: run.durationMs,
          startedAt: run.startedAt.getTime(),
          finishedAt: run.finishedAt?.getTime() ?? null,
          /** The end of the output (at most 16 KiB), plain text. */
          outputTail: status === "running" ? null : tailOf(run),
          /** Where the full output downloads, or `null` when it was not saved. */
          fullOutputPath: run.outputBlobId === null ? null : checkOutputPath(task.id, run.id),
        };
      }),
    };
  });
  views.sort((a, b) => b.startedAt - a.startedAt || b.turnNumber - a.turnNumber);

  // "Ask the agent to fix" belongs to the newest turn that has results, and only when one failed.
  const newest = views.find((turn) => !turn.running);
  const failingNow = newest === undefined ? [] : newest.runs.filter((run) => run.status !== "running" && isFailingCheck(run.status));
  const newestFinished = views[0];

  const pullRequests = taskRepos.flatMap((row) =>
    row.pullRequests.map((pr) => ({
      repoId: repoIdSchema.parse(row.repoId),
      repo: row.repo.fullName,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      draft: pr.draft,
      /** True when ostra made it a draft because a check failed: it marks it ready when they pass. */
      draftByOstra: pr.draftByOstra,
    })),
  );

  return {
    /** The project's environment names checks. */
    configured: definitions.length > 0,
    checks: definitions.map((check) => ({
      checkId: checkIdSchema.parse(check.id),
      name: check.name,
      command: check.command,
      repoId: check.repoId === null ? null : repoIdSchema.parse(check.repoId),
      repo: check.repoId === null ? null : (repoName.get(check.repoId) ?? null),
      timeoutSeconds: check.timeoutSeconds,
    })),
    /** The task's runner is on protocol minor 1: it runs no checks. */
    runnerTooOld: presence !== null && presence.minor < 2,
    turns: views,
    pullRequests,
    fix: {
      available: failingNow.length > 0 && newestFinished !== undefined,
      failing: failingNow.length,
      turnNumber: newest?.turnNumber ?? null,
    },
  };
};

export type ChecksView = Awaited<ReturnType<typeof loadChecksView>>;
