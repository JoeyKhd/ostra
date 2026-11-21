"use client";

import { ArrowRightIcon, BookOpenIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StepTick } from "@/components/ui/step-tick";
import type { StepLook } from "@/components/ui/step-tick";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// The first-run checklist's rows (home-first-run.md, F-076), with the Linear step live. The shape
// is `setup.status`'s from ticket 27: each step `done`, `skipped` or `open`, and the Linear step
// also `pending` or `failed` from its connection. Milestone 7 (ticket 24): each row links to its
// page in the docs (`OSTRA_DOCS_URL`), in a new tab.

export type SetupStep = RouterOutputs["setup"]["status"]["steps"][number];
export type SetupStepId = SetupStep["id"];
export type SetupStepState = SetupStep["state"];

type StepCopy = { readonly title: MessageKey; readonly body: MessageKey; readonly href: string; readonly action: MessageKey };

const copy: Readonly<Record<SetupStepId, StepCopy>> = {
  admin: { title: "checklist.admin.title", body: "checklist.admin.body", href: "/", action: "checklist.admin.action" },
  "model-provider": { title: "checklist.model.title", body: "checklist.model.body", href: "/organization/models", action: "checklist.model.action" },
  github: { title: "checklist.github.title", body: "checklist.github.body", href: "/organization/github", action: "checklist.github.action" },
  linear: { title: "checklist.linear.title", body: "checklist.linear.body", href: "/organization/linear", action: "checklist.linear.action" },
  project: { title: "checklist.project.title", body: "checklist.project.body", href: "/projects/new", action: "checklist.project.action" },
  runner: { title: "checklist.runner.title", body: "checklist.runner.body", href: "/organization/runners", action: "checklist.runner.action" },
  "first-task": { title: "checklist.task.title", body: "checklist.task.body", href: "/tasks/new", action: "checklist.task.action" },
};

/** Done and skipped steps are settled; the progress counts both. */
export const settledCount = (steps: readonly SetupStep[]): number => steps.filter((step) => step.state === "done" || step.state === "skipped").length;

const tickLook = (state: SetupStepState, next: boolean): StepLook =>
  state === "done" ? "done" : state === "skipped" ? "skipped" : next && state !== "failed" ? "current" : "later";

/** The step's body: the Linear step says where its connection stands. */
const bodyOf = (step: SetupStep): MessageKey => {
  if (step.id !== "linear") return copy[step.id].body;
  switch (step.state) {
    case "pending":
      return "checklist.linear.pending";
    case "failed":
      return "checklist.linear.failed";
    case "skipped":
      return "checklist.linear.skipped";
    case "done":
    case "open":
      return copy.linear.body;
    default:
      return step.state satisfies never;
  }
};

const actionOf = (step: SetupStep): MessageKey =>
  step.id !== "linear" ? copy[step.id].action : step.state === "pending" ? "checklist.linear.continue" : step.state === "failed" ? "checklist.linear.authorizeAgain" : copy.linear.action;

export type SetupStepsProps = {
  readonly steps: readonly SetupStep[];
  readonly next: SetupStepId | null;
  readonly admin: boolean;
  /** `setup.skip({ step: "linear" })`. */
  readonly skip: { readonly run: () => void; readonly pending: boolean };
};

/** One row per step: the circle, the title over the body, and the action on the right. */
export const SetupSteps = ({ steps, next, admin, skip }: SetupStepsProps) => (
  <ol className="rows" data-testid="setup-checklist">
    {steps.map((step, i) => {
      const view = copy[step.id];
      const isNext = next === step.id;
      const settled = step.state === "done" || step.state === "skipped";
      const canAct = admin || step.id === "first-task";
      const failed = step.id === "linear" && step.state === "failed";
      return (
        <li
          key={step.id}
          data-step={step.id}
          data-state={step.state}
          data-next={isNext}
          data-done={step.state === "done"}
          className="flex min-h-[52px] flex-wrap items-center gap-x-3.5 gap-y-2 py-1.5 sm:flex-nowrap"
        >
          <StepTick state={tickLook(step.state, isNext)} n={i + 1} />
          <div className="min-w-0 flex-1">
            <div className={cn("font-medium", settled && "text-muted")}>{t(view.title)}</div>
            <div className="flex items-start gap-1.5 text-sm text-muted">
              {failed ? <TriangleAlertIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75] text-red" /> : null}
              <span>
                {t(bodyOf(step))}{" "}
                <a
                  href={step.docs}
                  target="_blank"
                  rel="noreferrer"
                  data-docs
                  aria-label={t("checklist.docsLabel", { step: t(view.title) })}
                  className="inline-flex items-center gap-1 whitespace-nowrap text-muted underline-offset-2 hover:text-text hover:underline"
                >
                  <BookOpenIcon aria-hidden className="size-[12px] stroke-[1.75]" />
                  {t("checklist.docs")}
                </a>
              </span>
            </div>
          </div>
          {!canAct || step.state === "done" ? null : step.state === "skipped" ? (
            <Link href={view.href} className="ml-[40px] shrink-0 text-ui text-teal hover:underline sm:ml-0">
              {t("checklist.linear.action")}
            </Link>
          ) : (
            <div className="ml-[40px] flex shrink-0 flex-row-reverse items-center gap-4 sm:ml-0 sm:flex-row">
              {step.id === "linear" && step.state === "open" ? (
                <Button variant="link" className="h-auto px-0 text-ui" disabled={skip.pending} onClick={skip.run}>
                  {skip.pending ? t("checklist.linear.skipping") : t("checklist.linear.skip")}
                </Button>
              ) : null}
              <Link href={view.href} className={buttonVariants({ variant: isNext && !failed ? "primary" : "outline" })}>
                {t(actionOf(step))}
                <ArrowRightIcon className="size-3!" />
              </Link>
            </div>
          )}
        </li>
      );
    })}
  </ol>
);

/** Four skeleton rows while `setup.status` loads. */
export const SetupStepsLoading = () => (
  <ul className="rows" aria-busy>
    {[0, 1, 2, 3].map((i) => (
      <li key={i} className="flex h-[52px] items-center gap-3">
        <Skeleton className="size-[22px] rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="w-[180px]" />
          <Skeleton className="w-[340px]" />
        </div>
      </li>
    ))}
  </ul>
);
