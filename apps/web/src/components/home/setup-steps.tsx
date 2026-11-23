"use client";

import { ArrowRightIcon, BookOpenIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StepTick } from "@/components/ui/step-tick";
import type { StepLook } from "@/components/ui/step-tick";
import { TrackerMark, trackerMarkAt, trackerName } from "@/components/trackers/tracker-mark";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import { tNodes } from "@/lib/message-nodes";
import type { RouterOutputs } from "@/lib/trpc";

// The first-run checklist's rows (home-first-run.md, F-076), with the tracker step live: step 4,
// "Connect a tracker", for Linear or Jira (setup-checklist.md, F-152/c7). The shape is
// `setup.status`'s: each step `done`, `skipped` or `open`, and the tracker step also `pending` or
// `failed` from its connection, which it names. Milestone 7 (ticket 24): each row links to its page
// in the docs (`OSTRA_DOCS_URL`), in a new tab. Milestone 11 (ticket 16): the step's five states
// read the connection's kind (`Jira` or `Linear`) and name.

export type SetupStep = RouterOutputs["setup"]["status"]["steps"][number];
export type SetupStepId = SetupStep["id"];
export type SetupStepState = SetupStep["state"];
/** A step's connection: the tracker step's `pending`, `failed` or `done` connection, else absent. */
type StepConnection = NonNullable<SetupStep["connection"]>;

type StepCopy = { readonly title: MessageKey; readonly body: MessageKey; readonly href: string; readonly action: MessageKey };

const copy: Readonly<Record<SetupStepId, StepCopy>> = {
  admin: { title: "checklist.admin.title", body: "checklist.admin.body", href: "/", action: "checklist.admin.action" },
  "model-provider": { title: "checklist.model.title", body: "checklist.model.body", href: "/organization/models", action: "checklist.model.action" },
  github: { title: "checklist.github.title", body: "checklist.github.body", href: "/organization/github", action: "checklist.github.action" },
  // Milestone 11 (ticket 16): `Connect a tracker`, to Trackers, whose empty state is the picker.
  tracker: { title: "checklist.tracker.title", body: "checklist.tracker.body", href: "/organization/trackers", action: "checklist.tracker.action" },
  project: { title: "checklist.project.title", body: "checklist.project.body", href: "/projects/new", action: "checklist.project.action" },
  runner: { title: "checklist.runner.title", body: "checklist.runner.body", href: "/organization/runners", action: "checklist.runner.action" },
  "first-task": { title: "checklist.task.title", body: "checklist.task.body", href: "/tasks/new", action: "checklist.task.action" },
};

/** Done and skipped steps are settled; the progress counts both. */
export const settledCount = (steps: readonly SetupStep[]): number => steps.filter((step) => step.state === "done" || step.state === "skipped").length;

const tickLook = (state: SetupStepState, next: boolean): StepLook =>
  state === "done" ? "done" : state === "skipped" ? "skipped" : next && state !== "failed" ? "current" : "later";

/** The tracker step's own page: its connection's while one stands, else Trackers. */
const stepHref = (step: SetupStep): string => {
  if (step.id !== "tracker") return copy[step.id].href;
  return step.connection === null || step.connection === undefined ? copy.tracker.href : `/organization/trackers/${step.connection.id}`;
};

/** A tracker's mark and its owner's name, on the text's baseline (`vertical-align: -2px`). */
const KindName = ({ kind }: { readonly kind: StepConnection["kind"] }) => (
  <span className="inline-flex items-center gap-1.5 align-[-2px] text-text-2">
    <TrackerMark kind={kind} size={trackerMarkAt.setupStep.size} label={false} className="align-[-2px]" />
    {trackerName[kind]}
  </span>
);

/** The body of the tracker step's pending, failed and done states: each names the connection. */
const namedBody = (state: "pending" | "failed" | "done", connection: StepConnection): ReactNode => {
  if (state === "done") {
    return tNodes("checklist.tracker.done", {
      name: (
        <span className="inline-flex items-center gap-1.5 align-[-2px]">
          <TrackerMark kind={connection.kind} size={trackerMarkAt.setupStep.size} label={false} className="align-[-2px]" />
          <span className="text-text-2">{connection.name}</span>
        </span>
      ),
    });
  }
  const key: MessageKey =
    state === "pending"
      ? connection.kind === "jira"
        ? "checklist.tracker.pending.jira"
        : "checklist.tracker.pending.linear"
      : connection.kind === "jira"
        ? "checklist.tracker.failed.jira"
        : "checklist.tracker.failed.linear";
  return tNodes(key, { name: <span className="text-text-2">{connection.name}</span> });
};

/** The step's body: the tracker step says where its connection stands, in its kind's words. */
const bodyOf = (step: SetupStep): ReactNode => {
  if (step.id !== "tracker") return t(copy[step.id].body);
  const connection = step.connection ?? null;
  if (connection !== null && step.state !== "open" && step.state !== "skipped") return namedBody(step.state, connection);
  // `open`, `skipped`, or a pending/failed state the server sends no connection with (never, in practice): both kinds, offered.
  return step.state === "skipped" ? t("checklist.tracker.skipped") : tNodes("checklist.tracker.body", { linear: <KindName kind="linear" />, jira: <KindName kind="jira" /> });
};

/** What a row's action says and where it goes: `Continue` on a connection's page, else the step's page. */
const actionOf = (step: SetupStep): { readonly key: MessageKey; readonly href: string } => {
  if (step.id !== "tracker") return { key: copy[step.id].action, href: copy[step.id].href };
  switch (step.state) {
    case "pending":
      return { key: "checklist.tracker.continue", href: stepHref(step) };
    case "failed":
      return { key: step.connection?.kind === "jira" ? "checklist.tracker.replace" : "checklist.tracker.authorizeAgain", href: stepHref(step) };
    case "open":
    case "done":
    case "skipped":
      return { key: copy.tracker.action, href: copy.tracker.href };
    default:
      return step.state satisfies never;
  }
};

export type SetupStepsProps = {
  readonly steps: readonly SetupStep[];
  readonly next: SetupStepId | null;
  readonly admin: boolean;
  /** `setup.skip({ step: "tracker" })`. */
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
      const failed = step.id === "tracker" && step.state === "failed";
      const action = actionOf(step);
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
            <div className="flex items-start gap-1.5 text-[13.5px] text-muted">
              {failed ? <TriangleAlertIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75] text-red" /> : null}
              <span>
                {bodyOf(step)}{" "}
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
            <Link href={action.href} className="ml-[40px] shrink-0 text-ui text-teal hover:underline sm:ml-0">
              {t(action.key)}
            </Link>
          ) : (
            <div className="ml-[40px] flex shrink-0 flex-row-reverse items-center gap-4 sm:ml-0 sm:flex-row">
              {step.id === "tracker" && step.state === "open" ? (
                <Button variant="link" className="h-auto px-0 text-ui" disabled={skip.pending} onClick={skip.run}>
                  {skip.pending ? t("checklist.tracker.skipping") : t("checklist.tracker.skip")}
                </Button>
              ) : null}
              <Link href={action.href} className={buttonVariants({ variant: isNext && !failed ? "primary" : "outline" })}>
                {t(action.key)}
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
