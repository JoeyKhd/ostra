"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { projectColour } from "@/components/shell/project-colour";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

// F-037 (ticket 36; growing app-targets/m1/home and m3/needs-you): a budget's notices among the
// needs-you rows. "test1 is at 91% of its budget" at the warn line, "test1 reached its budget" at
// 100%, each opening Spend with the budget selected (or the project, for its project admins).

export type BudgetNotice = RouterOutputs["notifications"]["budgetNotices"][number];

/** The notice's sentence, with the share as it stands now. */
export const budgetNoticeText = (notice: BudgetNotice): string => {
  const name = notice.scope.kind === "project" ? notice.scope.name : null;
  if (notice.threshold === "reached") return name === null ? t("budgetNotice.reachedOrganization") : t("budgetNotice.reached", { project: name });
  const percent = notice.percent === null ? "" : String(notice.percent);
  return name === null ? t("budgetNotice.warnOrganization", { percent }) : t("budgetNotice.warn", { project: name, percent });
};

const hrefOf = (notice: BudgetNotice, organizationAdmin: boolean): string =>
  organizationAdmin
    ? `/organization/spend${notice.scope.kind === "project" ? `?project=${encodeURIComponent(notice.scope.projectId)}` : "?project=organization"}`
    : notice.scope.kind === "project"
      ? `/projects/${notice.scope.projectId}`
      : "/";

export const BudgetNoticeRows = ({ notices, organizationAdmin }: { readonly notices: readonly BudgetNotice[]; readonly organizationAdmin: boolean }) =>
  notices.length === 0 ? null : (
    <ul className="rows" data-testid="budget-notices">
      {notices.map((notice) => (
        <li key={notice.notificationId} className="flex min-h-[38px] items-center gap-2.5 border-b border-line py-1.5" data-testid="budget-notice" data-threshold={notice.threshold}>
          {notice.threshold === "reached" ? (
            <CircleAlertIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-red" />
          ) : (
            <TriangleAlertIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-muted" />
          )}
          {notice.scope.kind === "project" ? <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(notice.scope.projectId) }} /> : null}
          <span className={cn("min-w-0 flex-1 truncate", notice.read ? "text-muted" : "text-text")}>{budgetNoticeText(notice)}</span>
          <Link href={hrefOf(notice, organizationAdmin)} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-7 shrink-0 text-ui font-normal")}>
            {organizationAdmin ? t("budgetNotice.open") : t("budgetNotice.openProject")}
          </Link>
        </li>
      ))}
    </ul>
  );

/** The member's budget notices this month, from `notifications.budgetNotices`. */
export const useBudgetNotices = () => {
  const trpc = useTRPC();
  return useQuery({ ...trpc.notifications.budgetNotices.queryOptions(), refetchInterval: 30_000 });
};
