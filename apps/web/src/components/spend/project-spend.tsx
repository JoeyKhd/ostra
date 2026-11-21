"use client";

import { skipToken, useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { ProjectId } from "@ostra/protocol";

import { PropGroup, PropRow } from "@/components/shell/page-frame";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTokenCount } from "@/components/insights/insights-words";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { formatShare, formatUsd } from "./spend-words";

// F-037 (ticket 36, growing app-targets/m1/project): the project's month on its own page, from the
// same rollup as Spend (`spend.project` reads `SpendDaily`), with its budget's share when it has one.

export const ProjectSpend = ({ projectId, organizationAdmin }: { readonly projectId: ProjectId; readonly organizationAdmin: boolean }) => {
  const trpc = useTRPC();
  const current = useQuery(trpc.spend.currentMonth.queryOptions());
  const month = useQuery({ ...trpc.spend.project.queryOptions(current.data === undefined ? skipToken : { projectId, month: current.data }), refetchInterval: 30_000 });
  const data = month.data;
  const budget = data?.budgets.find((one) => one.scope.kind === "project" && one.scope.projectId === projectId);
  const spent = data?.byProject.find((line) => line.line.kind === "project" && line.line.projectId === projectId)?.spentMicroUsd ?? 0;
  const tokens = data?.byModel.reduce((sum, line) => sum + line.inputTokens + line.outputTokens + line.cacheReadTokens + line.cacheWriteTokens, 0) ?? 0;
  return (
    <PropGroup title={t("projectSpend.title")}>
      <div data-testid="project-spend">
        {data === undefined ? (
          <Skeleton className="my-2 h-4 w-40" />
        ) : (
          <>
            <PropRow labelWidth={120} label={t("projectSpend.spent")}>
              <span className="font-mono" data-testid="project-spend-month">{formatUsd(spent)}</span>
            </PropRow>
            <PropRow labelWidth={120} label={t("projectSpend.budget")}>
              {budget === undefined ? (
                <span className="text-faint">{t("spend.noBudget")}</span>
              ) : (
                <span className={cn("font-mono", budget.state === "reached" && "text-red")} data-testid="project-spend-share">
                  {t("projectSpend.share", { share: budget.share === null ? "–" : formatShare(budget.share), budget: formatUsd(budget.monthlyMicroUsd) })}
                </span>
              )}
            </PropRow>
            {tokens === 0 ? null : (
              <PropRow labelWidth={120} label={t("projectSpend.tokens")}>
                <span className="font-mono">{formatTokenCount(tokens)}</span>
              </PropRow>
            )}
            {organizationAdmin ? (
              <Link href={`/organization/spend?project=${encodeURIComponent(projectId)}`} className="mt-1.5 inline-block text-ui text-teal hover:underline">
                {t("projectSpend.open")}
              </Link>
            ) : null}
          </>
        )}
      </div>
    </PropGroup>
  );
};
