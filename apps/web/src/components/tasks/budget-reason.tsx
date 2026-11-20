"use client";

import { PauseIcon } from "lucide-react";
import Link from "next/link";

import { t } from "@/lib/messages";

// F-037 (ticket 36, ADR 0055): why a new task would wait at the budget gate, before Start. The task
// still starts: it's created queued, and goes once an admin raises the budget, prices the model or
// the month ends. New task and the Inbox show it from `tasks.startCheck`.

export type BudgetWait =
  | { readonly reason: "budget-reached"; readonly scope: "organization" | "project"; readonly month: string }
  | { readonly reason: "unpriced" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "2026-11" → "November"; a time in ms → its month's name, in UTC. */
export const monthWord = (month: string | number): string =>
  typeof month === "number" ? (MONTHS[new Date(month).getUTCMonth()] ?? "") : (MONTHS[Number(month.slice(5, 7)) - 1] ?? month);

/** The sentence, with the project's name for a project budget. */
export const budgetWaitText = (wait: BudgetWait, projectName: string): string =>
  wait.reason === "unpriced"
    ? t("budgetWait.unpriced")
    : wait.scope === "project"
      ? t("budgetWait.project", { project: projectName, month: monthWord(wait.month) })
      : t("budgetWait.organization", { month: monthWord(wait.month) });

export const BudgetReason = ({ id, wait, projectName, organizationAdmin }: {
  readonly id: string;
  readonly wait: BudgetWait;
  readonly projectName: string;
  readonly organizationAdmin: boolean;
}) => (
  <p id={id} role="status" className="mt-3 flex items-start gap-2 text-body" data-testid="budget-reason">
    <PauseIcon aria-hidden className="mt-[3px] size-[15px] shrink-0 stroke-[1.75] text-muted" />
    <span>
      <span className="text-text">{budgetWaitText(wait, projectName)}</span>{" "}
      <span className="text-muted">{t("budgetWait.startsQueued")}</span>{" "}
      {organizationAdmin ? (
        <Link href="/organization/spend" className="text-teal hover:underline">
          {t("budgetWait.openSpend")}
        </Link>
      ) : null}
    </span>
  </p>
);
