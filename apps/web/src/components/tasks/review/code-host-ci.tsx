"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";

import type { TaskId } from "@ostra/protocol";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ciWords } from "./review-words";

// The Checks tab's code-host CI (task-checks growing, task-rounds.md; F-035, ticket 35): each pull
// request's checks on its head as ostra read them, beside ostra's own checks; a failing one names
// the log file ostra handed the agent and the round it started.

const PASSING = new Set(["success", "neutral", "skipped"]);

export const CodeHostCi = ({ taskId }: { readonly taskId: TaskId }) => {
  const trpc = useTRPC();
  const screen = useQuery({ ...trpc.review.screen.queryOptions({ taskId }), retry: false, refetchInterval: 15_000 });
  const rounds = useQuery(trpc.tasks.rounds.queryOptions({ taskId }));
  const prs = (screen.data?.prs ?? []).filter((pr) => pr.ci !== null);
  if (prs.length === 0) return null;
  const ciRounds = (rounds.data?.rounds ?? []).filter((round) => round.cause.kind === "ci");
  return (
    <section className="mt-4" data-testid="code-host-ci" aria-label={t("review.checks.title")}>
      <h2 className="text-ui font-semibold text-text">{t("review.checks.title")}</h2>
      {prs.map((pr) => (
        <div key={pr.taskRepoId} className="mt-2" data-pr={pr.prNumber ?? ""}>
          <p className="flex items-center gap-2 text-sm text-muted">
            <span className="font-mono text-text">{pr.repo}</span>
            {pr.prNumber === null ? null : <span className="font-mono text-faint">#{pr.prNumber}</span>}
            <span>· {ciWords(pr.ci?.state ?? null)}</span>
            {pr.headSha === null ? null : <span className="font-mono text-faint">· {pr.headSha.slice(0, 7)}</span>}
          </p>
          <ul className="mt-1">
            {(pr.ci?.checks ?? []).map((check) => {
              const passed = check.conclusion !== null && PASSING.has(check.conclusion);
              const round = ciRounds.find((one) => one.cause.kind === "ci" && one.cause.failing.some((failing) => failing.repo === pr.repo && failing.name === check.name));
              const log = round?.cause.kind === "ci" ? (round.cause.failing.find((failing) => failing.name === check.name)?.logFile ?? null) : null;
              return (
                <li key={check.name} className="flex min-h-[26px] items-center gap-2 text-sm" data-check={check.name} data-conclusion={check.conclusion ?? "pending"}>
                  {check.conclusion === null ? <LoaderCircleIcon aria-hidden className="size-[13px] animate-spin text-muted" /> : passed ? <CheckIcon aria-hidden className="size-[13px] text-green" /> : <XIcon aria-hidden className="size-[13px] text-red" />}
                  <span className="font-mono text-text">{check.name}</span>
                  <span className="text-faint">{check.conclusion ?? t("review.checks.running")}</span>
                  {log === null ? null : <span className="font-mono text-teal">{log}</span>}
                  {round === undefined ? null : <span className="text-xs text-faint">{t("review.checks.startedRound", { n: round.number })}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
};
