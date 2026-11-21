"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TaskId } from "@ostra/protocol";

import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { propertyOf } from "./check-words";
import type { ChecksMarker, CheckRunView, FixDelivery, PrDraftLine, TurnChecksView } from "./check-words";
import { ChecksBody } from "./task-checks";
import type { FixState } from "./task-checks";
import { CodeHostCi } from "../review/code-host-ci";

// Ticket 47 wired (task-checks.md; F-054): `tasks.checks` drawn by the Checks tab's parts, and "Ask
// the agent to fix" through `tasks.fixChecks`. The API's shapes are read here once.

type Checks = RouterOutputs["tasks"]["checks"];
type ApiTurn = Checks["turns"][number];

const runViewOf = (run: ApiTurn["runs"][number], timeoutSeconds: number): CheckRunView => ({
  checkId: run.checkId,
  name: run.name,
  command: run.command ?? "",
  repo: run.repo,
  status: run.status,
  exitCode: run.exitCode,
  durationMs: run.durationMs,
  timeoutMs: timeoutSeconds * 1000,
  startedAt: run.startedAt,
  outputTail: run.outputTail ?? "",
  downloadUrl: run.fullOutputPath,
});

export const turnsViewOf = (checks: Checks): readonly TurnChecksView[] => {
  const timeoutOf = new Map(checks.checks.map((check) => [check.checkId, check.timeoutSeconds] as const));
  return checks.turns.map((turn) => ({
    turn: turn.turnNumber,
    at: turn.startedAt,
    sha: turn.heads[0]?.headSha ?? null,
    heads: turn.heads.map((head) => ({ repo: head.repo, sha: head.headSha })),
    checks: turn.runs.map((run) => runViewOf(run, timeoutOf.get(run.checkId) ?? 600)),
  }));
};

/** Milestone 4 (F-098): the task's repos in the project's order, which the turns' sections follow. */
export const reposOf = (checks: Checks): readonly string[] => checks.repos.map((repo) => repo.repo);

export const prLinesOf = (checks: Checks, newestTurn: number): readonly PrDraftLine[] => {
  const several = checks.repos.length > 1;
  return checks.pullRequests
    .filter((pr) => pr.state === "open")
    .map((pr) => ({
      number: pr.number,
      repo: several ? pr.repo : null,
      url: pr.url,
      state: pr.draft ? (pr.draftByOstra ? "draft-by-ostra" : "draft-by-person") : "ready-by-ostra",
      turn: newestTurn,
    }));
};

/** The properties panel's `Checks` row (task-checks.md, "Properties"), or `null` when no check ran. */
export const checksPropertyOf = (checks: Checks | undefined) => (checks === undefined ? null : propertyOf(turnsViewOf(checks)));

/** The tab's marker: running, passed, or how many failed in the newest finished turn. */
export const checksMarkerOf = (checks: Checks | undefined): ChecksMarker => {
  const newest = checks?.turns[0];
  if (newest === undefined) return { kind: "none" };
  if (newest.running) return { kind: "running" };
  const failing = newest.counts.failed + newest.counts.timedOut + newest.counts.error;
  return failing > 0 ? { kind: "failing", count: failing } : { kind: "passed" };
};

export const ChecksTab = ({
  taskId,
  projectId,
  agent,
  driver,
  isDriver,
  running,
  sessionGoing,
  now,
  onTakeOver,
  onSeeActivity,
}: {
  readonly taskId: TaskId;
  readonly projectId: string;
  readonly agent: string;
  readonly driver: string | null;
  readonly isDriver: boolean;
  readonly running: boolean;
  readonly sessionGoing: boolean;
  readonly now: number;
  readonly onTakeOver: () => void;
  readonly onSeeActivity: () => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const checks = useQuery({ ...trpc.tasks.checks.queryOptions({ taskId }), refetchInterval: 10_000 });
  const fix = useMutation(trpc.tasks.fixChecks.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) }));
  const delivery: FixDelivery = !isDriver && sessionGoing ? { kind: "not-driver", driver: driver ?? t("taskPage.someone") } : !sessionGoing ? { kind: "reopen" } : running ? { kind: "after-turn" } : { kind: "next-turn" };
  const state: FixState = fix.isPending
    ? { kind: "sending" }
    : fix.error !== null
      ? { kind: "refused", message: errorText(fix.error) ?? t("errors.unknown") }
      : fix.isSuccess
        ? { kind: "sent", at: fix.submittedAt }
        : { kind: "idle" };
  const data = checks.data;
  const load =
    data !== undefined
      ? { kind: "ready" as const, configured: data.configured, supported: !data.runnerTooOld, turns: turnsViewOf(data), prLines: prLinesOf(data, data.fix.turnNumber ?? data.turns[0]?.turnNumber ?? 0), repos: reposOf(data) }
      : checks.error !== null
        ? { kind: "error" as const, message: errorText(checks.error) ?? t("errors.unknown"), retry: () => void checks.refetch() }
        : { kind: "loading" as const };
  return (
    <>
      {/* Milestone 6 (F-035, ticket 35): the code host's CI per pull request, beside ostra's checks. */}
      <CodeHostCi taskId={taskId} />
      <ChecksBody
        load={load}
        now={now}
        environmentHref={`/projects/${projectId}/environment?tab=services`}
        fix={{ agent, delivery, state, onFix: () => { fix.mutate({ taskId }); }, onTakeOver, onSeeActivity }}
      />
    </>
  );
};
