"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";

import { Section } from "@/components/shell/page-frame";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

type StepId = RouterOutputs["setup"]["status"]["steps"][number]["id"];

type StepView = { readonly title: MessageKey; readonly body: MessageKey; readonly href: string; readonly action: MessageKey };

const steps: Readonly<Record<StepId, StepView>> = {
  admin: { title: "checklist.admin.title", body: "checklist.admin.body", href: "/", action: "checklist.admin.action" },
  "model-provider": { title: "checklist.model.title", body: "checklist.model.body", href: "/organization/models", action: "checklist.model.action" },
  github: { title: "checklist.github.title", body: "checklist.github.body", href: "/organization/github", action: "checklist.github.action" },
  project: { title: "checklist.project.title", body: "checklist.project.body", href: "/projects/new", action: "checklist.project.action" },
  runner: { title: "checklist.runner.title", body: "checklist.runner.body", href: "/organization/runners", action: "checklist.runner.action" },
  "first-task": { title: "checklist.task.title", body: "checklist.task.body", href: "/tasks/new", action: "checklist.task.action" },
};

const Tick = ({ done, n }: { readonly done: boolean; readonly n: number }) => (
  <span
    className={cn(
      "inline-grid size-[22px] shrink-0 place-items-center rounded-full border font-mono text-[11px]",
      done ? "border-green bg-green text-ink" : "border-line-2 text-muted",
    )}
  >
    {done ? <CheckIcon className="size-3" aria-label={t("checklist.done")} /> : n}
  </span>
);

/**
 * The first-run checklist (F-076), on Home for a new organization: in its order, each step ticked
 * from the tables (`setup.status`). Linear is shown as milestone 2's and skipped.
 */
export const SetupChecklist = ({ admin }: { readonly admin: boolean }) => {
  const trpc = useTRPC();
  const status = useQuery(trpc.setup.status.queryOptions());
  if (status.data === undefined || status.data.next === null) return null;
  const done = status.data.steps.filter((step) => step.done).length;
  return (
    <Section title={t("checklist.title")} end={<span className="font-mono text-faint">{t("checklist.progress", { done, total: status.data.steps.length })}</span>}>
      <ol className="rows" data-testid="setup-checklist">
        {status.data.steps.map((step, i) => {
          const view = steps[step.id];
          const next = status.data.next === step.id;
          return (
            <li key={step.id} data-step={step.id} data-done={step.done} className="flex min-h-[52px] items-center gap-3 py-2.5">
              <Tick done={step.done} n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className={cn("font-medium", step.done && "text-muted")}>{t(view.title)}</div>
                <div className="text-sm text-muted">{t(view.body)}</div>
              </div>
              {step.done || (!admin && step.id !== "first-task") ? null : (
                <Link
                  href={view.href}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-[11px] text-[12.5px] font-medium",
                    next ? "border-shell bg-shell font-semibold text-ink" : "border-line-2 bg-surface text-text hover:bg-sel",
                  )}
                >
                  {t(view.action)}
                  <ArrowRightIcon className="size-3" />
                </Link>
              )}
            </li>
          );
        })}
        <li data-step="linear" className="flex min-h-[52px] items-center gap-3 py-2.5 text-faint">
          <span className="inline-grid size-[22px] shrink-0 place-items-center rounded-full border border-dashed border-line-2 font-mono text-[11px]">–</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t("checklist.linear.title")}</div>
            <div className="text-sm">{t("checklist.linear.body")}</div>
          </div>
          <span className="shrink-0 font-mono text-sm">{t("checklist.linear.later")}</span>
        </li>
      </ol>
    </Section>
  );
};
