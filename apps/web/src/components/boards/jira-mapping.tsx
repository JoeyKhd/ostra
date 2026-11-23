"use client";

import { CheckIcon, ChevronDownIcon, CornerDownRightIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { categoryGroups, categoryName, categoryOf, reachOf, statusExists, statusName } from "./board-words";
import type { BoardView, Category, Mapping, Workflow } from "./board-words";

// A Jira board's mapping (boards-mixed.md, F-008/c5, F-008/c7): Jira moves a ticket through its
// workflow's transitions, never by writing a status, so each step names a target status and the
// page says which transition ostra takes, from which statuses, and where none reaches. Without
// workflow access the lines and warnings are gone, and one line says why.

/** Jira's category square: 8px, 2px radius, always beside the status's name. */
export const CategorySquare = ({ category, className }: { readonly category: Category; readonly className?: string }) => (
  <span
    aria-hidden
    className={cn(
      "inline-block size-2 shrink-0 rounded-[2px]",
      category === "open" || category === "cancelled" ? "bg-line-3" : category === "done" ? "bg-green" : "jira-cat-started",
      className,
    )}
  />
);

const StatusValue = ({ board, id }: { readonly board: BoardView; readonly id: string }) =>
  statusExists(board, id) ? (
    <span className="flex min-w-0 items-center gap-2">
      <CategorySquare category={categoryOf(board, id)} />
      <span className="truncate">{statusName(board, id)}</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-2 text-red">
      <TriangleAlertIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75]" />
      <span className="truncate line-through">{statusName(board, id)}</span>
    </span>
  );

/** How a workflow's statuses reach a target: `reached from 3 of 5`, `from any status`, `not from Blocked`. */
const reachText = (workflow: Extract<Workflow, { readonly readable: true }>, statusId: string): string => {
  const reach = workflow.reach.find((line) => line.statusId === statusId);
  if (reach === undefined) return "";
  if (reach.global) return t("boards.jira.reachAny");
  if (reach.unreachable.length > 0) return t("boards.jira.reachNot", { status: reach.unreachable.map((id) => workflow.statuses.find((status) => status.id === id)?.name ?? id).join(` ${t("boards.jira.or")} `) });
  return t("boards.jira.reachFrom", { n: reach.reachedFrom.length, total: workflow.statuses.length });
};

/** The target-status picker: the workflow's statuses by category, each with how it's reached. */
const TargetSelect = ({ board, workflow, value, onChange, label }: { readonly board: BoardView; readonly workflow: Extract<Workflow, { readonly readable: true }> | undefined; readonly value: string; readonly onChange: (id: string) => void; readonly label: string }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger aria-label={label} className="h-[34px] w-full max-w-[300px] max-sm:h-11">
      <SelectValue placeholder={t("boards.mapping.pickStatus")}>{value === "" ? undefined : <StatusValue board={board} id={value} />}</SelectValue>
    </SelectTrigger>
    <SelectContent align="start" className="w-[330px]">
      {categoryGroups(board).map((group) => (
        <SelectGroup key={group.category}>
          <SelectLabel>{categoryName(group.category)}</SelectLabel>
          {group.statuses.map((status) => (
            <SelectItem key={status.id} value={status.id}>
              <CategorySquare category={group.category} />
              <span className="truncate">{status.name}</span>
              {workflow === undefined ? null : <span className="ml-auto shrink-0 pl-3 text-xs text-faint">{reachText(workflow, status.id)}</span>}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </SelectContent>
  </Select>
);

/** The Open picker: chips with their category square, a checklist of every status in the popover. */
const OpenPicker = ({ board, value, onChange }: { readonly board: BoardView; readonly value: readonly string[]; readonly onChange: (ids: readonly string[]) => void }) => {
  const toggle = (id: string) => { onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]); };
  return (
    <div className="flex min-h-[34px] w-full max-w-[400px] items-center gap-1.5 rounded-md border border-line-2 bg-surface py-1 pl-1.5 pr-1 max-sm:min-h-11">
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {value.map((id) => (
          <span key={id} className={cn("inline-flex h-[24px] items-center gap-1.5 rounded-sm border border-line-2 pl-2 pr-1 text-ui", statusExists(board, id) ? "text-text" : "text-red")}>
            <StatusValue board={board} id={id} />
            <button type="button" aria-label={t("boards.mapping.remove", { name: statusName(board, id) })} onClick={() => { toggle(id); }} className="grid size-5 place-items-center rounded-sm text-muted hover:bg-sel hover:text-text">
              <XIcon aria-hidden className="size-3 stroke-[1.75]" />
            </button>
          </span>
        ))}
      </div>
      <Popover>
        <PopoverTrigger disabled={categoryGroups(board).length === 0} aria-label={t("boards.mapping.addStatus")} className="grid size-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-sel hover:text-text disabled:pointer-events-none disabled:opacity-50">
          <ChevronDownIcon aria-hidden className="size-4 stroke-[1.75]" />
        </PopoverTrigger>
        <PopoverContent className="w-[280px]">
          {categoryGroups(board).map((group) => (
            <div key={group.category} role="group" aria-label={categoryName(group.category)}>
              <div className="px-2 pb-1 pt-2 text-xs font-medium text-faint">{categoryName(group.category)}</div>
              {group.statuses.map((status) => (
                <button
                  key={status.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={value.includes(status.id)}
                  onClick={() => { toggle(status.id); }}
                  className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-ui text-text hover:bg-sel"
                >
                  <CategorySquare category={group.category} />
                  <span className="flex-1 truncate">{status.name}</span>
                  {value.includes(status.id) ? <CheckIcon aria-hidden className="size-[14px] stroke-[1.75] text-text" /> : null}
                </button>
              ))}
            </div>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
};

const Step = ({ name, hint, children }: { readonly name: string; readonly hint?: string; readonly children: ReactNode }) => (
  <div className="grid min-h-12 grid-cols-1 items-start gap-x-4 gap-y-1.5 border-b border-line py-1.5 sm:grid-cols-[200px_minmax(0,1fr)]">
    <div>
      <div className="text-body leading-5 font-medium text-text">{name}</div>
      {hint === undefined ? null : <div className="text-xs leading-4 text-faint">{hint}</div>}
    </div>
    <div className="flex min-w-0 flex-col items-start gap-1.5">{children}</div>
  </div>
);

/** One step's `by …` lines and the statuses no route leaves toward its target. */
const StepReach = ({ board, workflow, step, workflowUrl }: { readonly board: BoardView; readonly workflow: Extract<Workflow, { readonly readable: true }> | undefined; readonly step: "started" | "inReview" | "done"; readonly workflowUrl: string | null }) => {
  const reach = reachOf(workflow, step);
  if (reach === undefined) return null;
  const names = (from: readonly string[]) => from.map((id) => workflow?.statuses.find((status) => status.id === id)?.name ?? id).join(` ${t("boards.jira.or")} `);
  return (
    <>
      {reach.by.map((line) => (
        <div key={line.transition.id} className="flex items-start gap-1.5 text-[12.5px] text-faint">
          <CornerDownRightIcon aria-hidden className="mt-[2px] size-3 shrink-0 stroke-[1.75]" />
          <span>
            {line.from === "any"
              ? t("boards.jira.byAny", { transition: line.transition.name })
              : t("boards.jira.by", { transition: line.transition.name, statuses: names(line.from) })}
          </span>
        </div>
      ))}
      {reach.unreachable.map((id) => (
        <div key={id} className="flex items-start gap-1.5 text-[12.5px] text-text-2">
          <TriangleAlertIcon aria-hidden className="mt-[2px] size-[13px] shrink-0 stroke-[1.75] text-red" />
          <span>
            {t("boards.jira.unreachable", { status: statusName(board, reach.target), from: workflow?.statuses.find((status) => status.id === id)?.name ?? id })}{" "}
            <WorkflowLink href={workflowUrl} />
          </span>
        </div>
      ))}
    </>
  );
};

/** `Workflow in Jira ↗`: the site's workflow admin, when the connection's site is known. */
const WorkflowLink = ({ href }: { readonly href: string | null }) =>
  href === null ? (
    <span className="whitespace-nowrap text-teal">{t("boards.jira.workflowLink")} ↗</span>
  ) : (
    <Link href={href} target="_blank" rel="noreferrer" className="whitespace-nowrap text-teal hover:underline">
      {t("boards.jira.workflowLink")} ↗
    </Link>
  );

export type JiraMappingProps = {
  readonly board: BoardView;
  readonly mapping: Mapping;
  readonly onChange: (mapping: Mapping) => void;
  readonly canEdit: boolean;
  readonly workflow: Workflow | undefined;
  readonly workflowError: string | null;
  /** The Jira site's workflow admin, when the connection's site is known: the warning's link. */
  readonly workflowUrl: string | null;
};

/** A Jira board's mapping: each step's target status and transition lines, who moves Done, no magic word. */
export const JiraMapping = ({ board, mapping, onChange, canEdit, workflow, workflowError, workflowUrl }: JiraMappingProps) => {
  const readable = workflow?.readable === true ? workflow : undefined;
  const target = (step: "started" | "inReview" | "done", label: string) =>
    canEdit ? (
      <TargetSelect board={board} workflow={readable} value={mapping[step]} label={label} onChange={(id) => { onChange({ ...mapping, [step]: id }); }} />
    ) : (
      <span className="flex h-[34px] items-center text-body text-text">
        <StatusValue board={board} id={mapping[step]} />
      </span>
    );
  return (
    <div className="border-t border-line" data-testid="mapping">
      {workflow !== undefined && !workflow.readable ? (
        <p className="flex items-start gap-2 border-b border-line py-2.5 text-[12.5px] text-text-2" data-testid="jira-not-readable">
          <InfoIcon aria-hidden className="mt-[2px] size-[14px] shrink-0 stroke-[1.75] text-muted" />
          {t("boards.jira.notReadable", { key: board.key ?? board.name })}
        </p>
      ) : null}
      {workflowError === null ? null : <p role="alert" className="border-b border-line py-2.5 text-[12.5px] text-red">{t("boards.jira.workflowError", { reason: workflowError })}</p>}
      <Step name={t("boards.mapping.open")} hint={t("boards.mapping.openHint")}>
        {canEdit ? (
          <OpenPicker board={board} value={mapping.open} onChange={(open) => { onChange({ ...mapping, open: [...open] }); }} />
        ) : (
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-body text-text">
            {mapping.open.map((id) => (
              <StatusValue key={id} board={board} id={id} />
            ))}
          </span>
        )}
      </Step>
      <Step name={t("boards.mapping.started")} hint={t("boards.mapping.startedHint")}>
        {target("started", t("boards.mapping.started"))}
        <StepReach board={board} workflow={readable} step="started" workflowUrl={workflowUrl} />
      </Step>
      <Step name={t("boards.mapping.inReview")} hint={t("boards.mapping.inReviewHint")}>
        {target("inReview", t("boards.mapping.inReview"))}
        <StepReach board={board} workflow={readable} step="inReview" workflowUrl={workflowUrl} />
      </Step>
      <Step name={t("boards.mapping.done")} hint={t("boards.mapping.doneHint")}>
        {target("done", t("boards.mapping.done"))}
        <StepReach board={board} workflow={readable} step="done" workflowUrl={workflowUrl} />
      </Step>
      <Step name={t("boards.mapping.doneBy")}>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
          <ToggleGroup
            type="single"
            value={mapping.doneBy}
            disabled={!canEdit}
            aria-label={t("boards.mapping.doneBy")}
            onValueChange={(value) => { if (value === "integration" || value === "ostra") onChange({ ...mapping, doneBy: value }); }}
          >
            <ToggleGroupItem value="integration">{t("boards.doneBy.jira")}</ToggleGroupItem>
            <ToggleGroupItem value="ostra">{t("boards.mapping.ostra")}</ToggleGroupItem>
          </ToggleGroup>
          <span className="max-w-[300px] text-[12.5px] leading-[1.4] text-faint">{t("boards.doneBy.jiraHelp")}</span>
        </div>
        {mapping.doneBy === "integration" ? (
          <p className="flex items-start gap-2 text-[12.5px] text-text-2" data-testid="jira-automation">
            <InfoIcon aria-hidden className="mt-[2px] size-[14px] shrink-0 stroke-[1.75] text-muted" />
            {t("boards.doneBy.jiraInfo", { key: board.key ?? board.name })}
          </p>
        ) : null}
      </Step>
    </div>
  );
};
