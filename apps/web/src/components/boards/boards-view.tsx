"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleXIcon,
  ContrastIcon,
  PauseIcon,
  TicketPlusIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { boardIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow, Section } from "@/components/shell/page-frame";
import { TrackerMark, trackerMarkAt } from "@/components/trackers/tracker-mark";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { tNodes } from "@/lib/message-nodes";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { AttachPicker } from "./attach-picker";
import {
  categoryName,
  groupStatuses,
  isJira,
  magicSample,
  mappedStep,
  mappingProblems,
  mappingSavable,
  nextTaskLines,
  sameMapping,
  shortAge,
  statusExists,
  statusName,
  statusTypeLabel,
} from "./board-words";
import type { BoardView, BoardsData, Mapping, NextLine, StatusType, Workflow } from "./board-words";
import { CategorySquare, JiraMapping } from "./jira-mapping";
import { PromptTickets } from "./prompt-tickets";

const icon = "size-[15px] shrink-0 stroke-[1.75] text-muted";

/** The workflow query's input while no board is selected: it's disabled, so the ID is never sent. */
const noBoard = boardIdSchema.parse("01900000-0000-7000-8000-000000000000");

/** A status type's icon: grey Lucide circles, never Linear's colours. */
export const StatusIcon = ({ type }: { readonly type: StatusType }) => {
  switch (type) {
    case "triage":
      return <CircleDashedIcon aria-hidden className={icon} />;
    case "backlog":
    case "unstarted":
    case "other":
      return <CircleIcon aria-hidden className={icon} />;
    case "started":
      return <ContrastIcon aria-hidden className={icon} />;
    case "completed":
      return <CircleCheckIcon aria-hidden className={icon} />;
    case "canceled":
      return <CircleXIcon aria-hidden className={icon} />;
    default:
      return type satisfies never;
  }
};

const typeOfId = (board: BoardView, id: string): StatusType => {
  const status = (board.statusGroups ?? []).flatMap((group) => group.statuses).find((item) => item.id === id);
  return status === undefined ? "other" : status.vendorType === "duplicate" ? "canceled" : (["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const).find((type) => type === status.vendorType) ?? "other";
};

/** A Linear status as a value: its icon and name; a gone one in red, struck through. */
const StatusValue = ({ board, id }: { readonly board: BoardView; readonly id: string }) =>
  statusExists(board, id) ? (
    <span className="flex min-w-0 items-center gap-2">
      <StatusIcon type={typeOfId(board, id)} />
      <span className="truncate">{statusName(board, id)}</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-2 text-red">
      <CircleAlertIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75]" />
      <span className="truncate line-through">{statusName(board, id)}</span>
    </span>
  );

/** The connection's activity for a board row: the last event (webhooks) or the last poll. */
const Activity = ({ board, now }: { readonly board: BoardView; readonly now: number }) =>
  board.connection.mode === "webhooks" && board.lastEvent !== null ? (
    <span className="flex items-center gap-2 text-ui text-muted">
      <Dot tone="green" />
      {t("boards.attached.lastEvent")} <span className="font-mono">{t("boards.attached.ago", { age: shortAge(board.lastEvent.at, now) })}</span>
    </span>
  ) : board.lastPolledAt === null ? (
    <span className="flex items-center gap-2 text-ui text-faint">
      <Dot tone="grey" />
      {t("boards.attached.neverPolled")}
    </span>
  ) : (
    <span className="flex items-center gap-2 text-ui text-muted">
      <Dot tone="grey" />
      {t("boards.attached.polled")} <span className="font-mono">{t("boards.attached.ago", { age: shortAge(board.lastPolledAt, now) })}</span>
    </span>
  );

/** A paused board's row: its connection's state where its activity would be. */
const PausedState = ({ board }: { readonly board: BoardView }) =>
  board.state.state === "attached" ? null : board.state.pausedBy === "failed" ? (
    <span className="flex items-center gap-2 text-ui text-muted">
      <Dot tone="red" />
      {t("boards.state.failed")}
    </span>
  ) : (
    <span className="flex items-center gap-2 text-ui text-muted">
      <Dot tone="grey" />
      {t("boards.state.paused")}
    </span>
  );

export type AttachedRowsProps = {
  readonly view: BoardsData;
  readonly selectedId: string | undefined;
  readonly onSelect: (board: BoardView) => void;
  readonly onDetach: (board: BoardView) => void;
  readonly detaching: boolean;
  readonly now: number;
};

/** The attached boards: one row each; a click selects it for the mapping and the panel. */
export const AttachedRows = ({ view, selectedId, onSelect, onDetach, detaching, now }: AttachedRowsProps) => (
  <ul data-testid="boards" className="border-t border-line">
    {view.boards.map((board) => {
      const paused = board.state.state !== "attached";
      const selected = board.id === selectedId;
      return (
        <li
          key={board.id}
          data-selected={selected}
          data-paused={paused}
          className={cn(
            "grid min-h-12 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-2 py-2 sm:grid-cols-[24px_minmax(0,1fr)_56px_128px_minmax(0,1fr)_64px] sm:py-0",
            selected ? "rounded-md bg-sel" : "hover:bg-hover",
            paused && "text-muted",
          )}
        >
          <TrackerMark kind={board.connection.kind} size={trackerMarkAt.boardRow.size} label={false} className="size-5 sm:size-[18px]" />
          <button type="button" onClick={() => { onSelect(board); }} aria-pressed={selected} className="flex min-w-0 flex-col items-start text-left">
            <span className={cn("flex min-w-0 items-baseline gap-2 text-body font-medium", paused ? "text-muted" : "text-text")}>
              <span className="truncate">{board.name}</span>
              <span className="font-mono text-[13px] font-normal text-faint sm:hidden">{board.key ?? "–"}</span>
            </span>
            <span className="truncate text-[12.5px] text-faint">
              {t("boards.via.line", { connection: board.connection.name, word: t(isJira(board) ? "boards.via.project" : "boards.via.team") })}
            </span>
          </button>
          <span className="hidden font-mono text-ui text-faint sm:block">{board.key ?? "–"}</span>
          <span className="hidden text-ui text-muted sm:block">
            <span className="font-mono">{board.openTickets}</span> {plural(board.openTickets, "boards.attached.tickets.one", "boards.attached.tickets.other")}
          </span>
          <span className="col-span-3 flex items-center gap-3 pl-[34px] text-[13px] text-muted sm:col-span-1 sm:block sm:pl-0 sm:text-ui">
            <span className="sm:hidden">
              <span className="font-mono">{board.openTickets}</span> {plural(board.openTickets, "boards.attached.tickets.one", "boards.attached.tickets.other")}
            </span>
            {paused ? <PausedState board={board} /> : <Activity board={board} now={now} />}
          </span>
          <span className="hidden items-center justify-end sm:flex">
            {view.canEdit ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={detaching}>
                    {t("boards.attached.detach")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent
                  title={t("boards.attached.detachTitle", { name: board.name })}
                  body={
                    board.ticketsForPromptTasks ? (
                      <>
                        {t("boards.attached.detachBody", { key: board.key ?? board.name })}{" "}
                        {tNodes("boards.promptTickets.detachMore", { setting: <b className="font-medium text-text">{t("boards.promptTickets.label")}</b> })}
                      </>
                    ) : (
                      t("boards.attached.detachBody", { key: board.key ?? board.name })
                    )
                  }
                  cancel={t("common.cancel")}
                  action={t("boards.attached.detach")}
                  onAction={() => { onDetach(board); }}
                />
              </AlertDialog>
            ) : null}
          </span>
        </li>
      );
    })}
  </ul>
);

/** The pause lines under the rows: a disconnected or failed connection, and where to fix it. */
export const PauseLines = ({ view }: { readonly view: BoardsData }) => (
  <>
    {view.boards.map((board) =>
      board.state.state === "attached" ? null : (
        <p key={board.id} className="mt-2 flex items-start gap-2 px-2 text-[12.5px] leading-[1.5] text-muted" data-testid="board-pause">
          {board.state.pausedBy === "failed" ? (
            <TriangleAlertIcon aria-hidden className="mt-[2px] size-[13px] shrink-0 stroke-[1.75] text-red" />
          ) : (
            <PauseIcon aria-hidden className="mt-[2px] size-[13px] shrink-0 stroke-[1.75]" />
          )}
          <span>
            {t(board.state.pausedBy === "failed" ? "boards.state.failedLine" : "boards.state.pausedLine", {
              connection: board.connection.name,
              date: day(board.state.since),
              key: board.key ?? board.name,
              kind: t(isJira(board) ? "boards.state.onJira" : "boards.state.onLinear"),
            })}{" "}
            <Link href="/organization/trackers" className="inline-flex items-center gap-1 whitespace-nowrap text-teal hover:underline">
              {t(board.state.pausedBy === "failed" ? "boards.state.reconnect" : "boards.state.trackers")}
              <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
            </Link>
          </span>
        </p>
      ),
    )}
  </>
);

/** One step's single-status picker, every status of a Linear team grouped by type. */
const StatusSelect = ({ board, value, onChange, label }: { readonly board: BoardView; readonly value: string; readonly onChange: (id: string) => void; readonly label: string }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger aria-label={label} className="h-[34px] w-full max-w-[300px] max-sm:h-11">
      <SelectValue placeholder={t("boards.mapping.pickStatus")}>{value === "" ? undefined : <StatusValue board={board} id={value} />}</SelectValue>
    </SelectTrigger>
    <SelectContent align="start">
      {groupStatuses(board).map((group) => (
        <SelectGroup key={group.type}>
          <SelectLabel>{statusTypeLabel(group.type)}</SelectLabel>
          {group.statuses.map((status) => (
            <SelectItem key={status.id} value={status.id}>
              <StatusIcon type={group.type} />
              {status.name}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </SelectContent>
  </Select>
);

/** The Open picker: chips in the trigger, a checklist of every status in the popover. */
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
        <PopoverTrigger disabled={groupStatuses(board).length === 0} aria-label={t("boards.mapping.addStatus")} className="grid size-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-sel hover:text-text disabled:pointer-events-none disabled:opacity-50">
          <ChevronDownIcon aria-hidden className="size-4 stroke-[1.75]" />
        </PopoverTrigger>
        <PopoverContent className="w-[280px]">
          {groupStatuses(board).map((group) => (
            <div key={group.type} role="group" aria-label={statusTypeLabel(group.type)}>
              <div className="px-2 pb-1 pt-2 text-xs font-medium text-faint">{statusTypeLabel(group.type)}</div>
              {group.statuses.map((status) => (
                <button
                  key={status.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={value.includes(status.id)}
                  onClick={() => { toggle(status.id); }}
                  className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-ui text-text hover:bg-sel"
                >
                  <StatusIcon type={group.type} />
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

const integrationLine = (integration: BoardView["integration"]): ReactNode => {
  switch (integration) {
    case "installed":
      return (
        <span className="flex items-center gap-2 text-ui text-text">
          <CircleCheckIcon aria-hidden className="size-[15px] stroke-[1.75] text-green" />
          {t("boards.mapping.installed")}
        </span>
      );
    case "not_installed":
      return (
        <span className="flex items-center gap-2 text-ui text-faint">
          <CircleMinusIcon aria-hidden className="size-[15px] stroke-[1.75]" />
          {t("boards.mapping.notInstalled")}
        </span>
      );
    case "unknown":
      return (
        <span className="flex items-center gap-2 text-ui text-faint">
          <CircleHelpIcon aria-hidden className="size-[15px] stroke-[1.75]" />
          {t("boards.mapping.unknown")}
        </span>
      );
    default:
      return integration satisfies never;
  }
};

const Step = ({ name, hint, hintRed = false, children }: { readonly name: string; readonly hint?: string; readonly hintRed?: boolean; readonly children: ReactNode }) => (
  <div className="grid min-h-12 grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line py-1.5 sm:grid-cols-[200px_minmax(0,1fr)]">
    <div>
      <div className="text-body leading-5 font-medium text-text">{name}</div>
      {hint === undefined ? null : <div className={cn("text-xs leading-4", hintRed ? "text-red" : "text-faint")}>{hint}</div>}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">{children}</div>
  </div>
);

export type MappingFormProps = {
  readonly board: BoardView;
  readonly mapping: Mapping;
  readonly onChange: (mapping: Mapping) => void;
  readonly canEdit: boolean;
};

/** A Linear board's status mapping: the four steps' statuses, who moves done, the magic word. */
export const MappingForm = ({ board, mapping, onChange, canEdit }: MappingFormProps) => {
  const problems = mappingProblems(board, mapping);
  const goneHint = (id: string, hint: string) => (problems.gone.has(id) ? { hint: t("boards.mapping.gone"), hintRed: true } : { hint });
  const single = (key: "started" | "inReview" | "done", label: string) =>
    canEdit ? (
      <StatusSelect board={board} value={mapping[key]} label={label} onChange={(id) => { onChange({ ...mapping, [key]: id }); }} />
    ) : (
      <span className="text-body text-text">
        <StatusValue board={board} id={mapping[key]} />
      </span>
    );
  const openGone = mapping.open.find((id) => problems.gone.has(id));
  return (
    <div className="border-t border-line" data-testid="mapping">
      <Step
        name={t("boards.mapping.open")}
        {...(problems.openEmpty ? { hint: t("boards.mapping.openEmpty"), hintRed: true } : openGone === undefined ? { hint: t("boards.mapping.openHint") } : { hint: t("boards.mapping.gone"), hintRed: true })}
      >
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
      <Step name={t("boards.mapping.started")} {...goneHint(mapping.started, t("boards.mapping.startedHint"))}>
        {single("started", t("boards.mapping.started"))}
      </Step>
      <Step name={t("boards.mapping.inReview")} {...goneHint(mapping.inReview, t("boards.mapping.inReviewHint"))}>
        {single("inReview", t("boards.mapping.inReview"))}
      </Step>
      <Step name={t("boards.mapping.done")} {...goneHint(mapping.done, t("boards.mapping.doneHint"))}>
        {single("done", t("boards.mapping.done"))}
      </Step>
      <Step name={t("boards.mapping.doneBy")}>
        <ToggleGroup
          type="single"
          value={mapping.doneBy}
          disabled={!canEdit}
          aria-label={t("boards.mapping.doneBy")}
          onValueChange={(value) => { if (value === "integration" || value === "ostra") onChange({ ...mapping, doneBy: value }); }}
        >
          <ToggleGroupItem value="integration">{t("boards.mapping.integration")}</ToggleGroupItem>
          <ToggleGroupItem value="ostra">{t("boards.mapping.ostra")}</ToggleGroupItem>
        </ToggleGroup>
        {integrationLine(board.integration)}
      </Step>
      {board.capabilities.magicWords ? (
        <Step name={t("boards.mapping.magicWord")} hint={t("boards.mapping.magicWordHint")}>
          <ToggleGroup
            type="single"
            value={mapping.magicWord}
            disabled={!canEdit}
            aria-label={t("boards.mapping.magicWord")}
            onValueChange={(value) => { if (value === "Closes" || value === "Refs") onChange({ ...mapping, magicWord: value }); }}
          >
            <ToggleGroupItem value="Closes" className="px-5">Closes</ToggleGroupItem>
            <ToggleGroupItem value="Refs" className="px-5">Refs</ToggleGroupItem>
          </ToggleGroup>
          <span className="font-mono text-ui text-faint">{magicSample(mapping, board.key)}</span>
        </Step>
      ) : null}
    </div>
  );
};

/** One sentence's words, with the status and the transition in `--text`. */
const NextLineText = ({ line }: { readonly line: NextLine }) => {
  const [before, afterStatus = ""] = line.text.split("{status}");
  const [between, afterTransition = ""] = afterStatus.split("{transition}");
  return (
    <span>
      {before}
      <b className="font-medium text-text">{line.status}</b>
      {between}
      {line.transition === null ? null : <b className="font-medium text-text">{line.transition}</b>}
      {afterTransition}
    </span>
  );
};

/** What the next task does on the ticket, one numbered sentence per step, from the unsaved mapping. */
export const NextTask = ({ board, mapping, workflow }: { readonly board: BoardView; readonly mapping: Mapping; readonly workflow?: Workflow }) => (
  <div className="mt-6" data-testid="next-task">
    <p className="mb-1.5 text-sm text-muted">{t("boards.next.title")}</p>
    <ol className="space-y-1">
      {nextTaskLines(board, mapping, workflow).map((line, i) => (
        <li key={line.text} className="grid grid-cols-[28px_minmax(0,1fr)] text-ui text-muted">
          <span className="font-mono text-faint">{i + 1}</span>
          <NextLineText line={line} />
        </li>
      ))}
    </ol>
  </div>
);

const PanelLabel = ({ children, count }: { readonly children: ReactNode; readonly count?: number }) => (
  <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-faint">
    {children}
    {count === undefined ? null : <span className="font-mono">{count}</span>}
  </h3>
);
const Sep = () => <div className="my-3.5 h-px bg-line" />;

const day = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(at);

/** The panel: the selected board, its tracker, and its statuses or workflow. */
export const BoardProperties = ({ view, board, mapping, now, workflow }: { readonly view: BoardsData; readonly board: BoardView | undefined; readonly mapping: Mapping | null; readonly now: number; readonly workflow?: Workflow }) => (
  <div data-testid="board-properties">
    {board === undefined ? null : (
      <>
        <PanelLabel>{t("boards.panel.board")}</PanelLabel>
        <PropRow label={t(isJira(board) ? "boards.panel.project" : "boards.panel.team")}>{board.name}</PropRow>
        <PropRow label={t("boards.panel.key")}>
          <span className="font-mono">{board.key ?? "–"}</span>
        </PropRow>
        <PropRow label={t("boards.panel.tracker")}>
          <TrackerMark kind={board.connection.kind} size={trackerMarkAt.property.size} label={false} />
          <span className="truncate">{board.connection.name}</span>
        </PropRow>
        <PropRow label={t("boards.panel.tickets")}>{t("boards.panel.openCount", { n: board.openTickets })}</PropRow>
        <PropRow label={t("boards.panel.mode")}>
          <Dot tone={board.connection.mode === "webhooks" ? "green" : "grey"} />
          {board.connection.mode === "webhooks" ? t("boards.panel.webhooks") : t("boards.panel.polling", { seconds: view.pollSeconds })}
        </PropRow>
        <PropRow label={t("boards.panel.lastEvent")}>
          <span className="font-mono">{board.lastEvent === null ? "–" : t("boards.attached.ago", { age: shortAge(board.lastEvent.at, now) })}</span>
        </PropRow>
        <PropRow label={t("boards.panel.attached")}>
          <span className="font-mono">{day(board.attachedAt)}</span>
        </PropRow>
        {/* F-097/c2: the board the project's prompt tasks get their tickets on (prompt-tickets.md). */}
        <PropRow label={t("boards.promptTickets.panelKey")}>
          {board.ticketsForPromptTasks ? (
            <>
              <TicketPlusIcon aria-hidden />
              <span className="truncate">{t("boards.promptTickets.panelHere")}</span>
            </>
          ) : (
            <span className="text-faint">–</span>
          )}
        </PropRow>
        {board.connection.agentMode ? (
          <PropRow label={t("boards.panel.agentMode")}>
            {board.startFromLinear ? t("boards.panel.takesDelegations") : <span className="text-faint">–</span>}
          </PropRow>
        ) : null}
        <Sep />
      </>
    )}
    {board === undefined ? null : board.capabilities.statusGraph ? (
      <>
        <PanelLabel count={workflow?.statuses.length ?? 0}>{t("boards.panel.workflowFor", { key: board.key ?? board.name })}</PanelLabel>
        {(workflow?.statuses ?? []).map((status) => (
          <div key={status.id} className="flex h-[26px] items-center gap-2 text-ui">
            <CategorySquare category={status.category} />
            <span className="min-w-0 flex-1 truncate text-text">{status.name}</span>
            <span className="text-xs text-faint">{categoryName(status.category)}</span>
          </div>
        ))}
        <Sep />
        <PanelLabel count={workflow?.readable === true ? workflow.transitions.length : 0}>{t("boards.panel.transitions")}</PanelLabel>
        {workflow?.readable === true
          ? workflow.transitions.map((transition) => (
              <div key={transition.id} className="flex min-h-6 items-center gap-2 text-ui">
                <span className="min-w-0 flex-1 truncate text-text">{transition.name}</span>
                <span className="text-[12.5px] text-faint">
                  {transition.from === "any" ? t("boards.panel.any") : transition.from.map((id) => workflow.statuses.find((status) => status.id === id)?.name ?? id).join(", ")} → {workflow.statuses.find((status) => status.id === transition.to)?.name ?? transition.to}
                </span>
              </div>
            ))
          : null}
      </>
    ) : (
      <>
        <PanelLabel count={(board.statusGroups ?? []).reduce((n, group) => n + group.statuses.length, 0)}>{t("boards.panel.statusesIn", { key: board.key ?? board.name })}</PanelLabel>
        {groupStatuses(board).map((group, i) => (
          <Fragment key={group.type}>
            {i > 0 ? <div className="my-2 h-px bg-line" /> : null}
            <div className="pb-0.5 text-xs text-faint">{statusTypeLabel(group.type)}</div>
            {group.statuses.map((status) => (
              <div key={status.id} className="flex h-[26px] items-center gap-2 text-ui">
                <StatusIcon type={group.type} />
                <span className="min-w-0 flex-1 truncate text-text">{status.name}</span>
                <span className="text-xs text-faint">{mappedStep(mapping, status.id)}</span>
              </div>
            ))}
          </Fragment>
        ))}
      </>
    )}
  </div>
);

const LoadingRows = ({ rows, height }: { readonly rows: number; readonly height: string }) => (
  <ul aria-busy className="border-t border-line">
    {Array.from({ length: rows }, (_, i) => (
      <li key={i} className={cn("flex items-center gap-4 border-b border-line", height)}>
        <Skeleton className="w-[140px]" />
        <Skeleton className="w-[260px]" />
      </li>
    ))}
  </ul>
);

/** Project › Boards (F-007, F-031, F-152; boards-mixed.md): boards from any of the organization's trackers. */
export const BoardsView = ({ projectId, admin }: { readonly projectId: ProjectId; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const boards = useQuery(trpc.boards.get.queryOptions({ projectId }));
  const canEdit = boards.data?.canEdit === true;
  const attachable = useQuery({ ...trpc.boards.attachable.queryOptions({ projectId }), enabled: canEdit });
  const [mounted] = useState(() => Date.now());
  const [edits, setEdits] = useState<Readonly<Record<string, Mapping>>>({});
  const [justAttached, setJustAttached] = useState(false);
  const [saved, setSaved] = useState(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.boards.pathKey() });
    await queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() });
  };
  const select = (boardId: string) => { router.replace(`${pathname}?board=${boardId}`, { scroll: false }); };
  const attach = useMutation(
    trpc.boards.attach.mutationOptions({
      onSuccess: async (result) => {
        setJustAttached(true);
        select(result.boardId);
        await refresh();
      },
    }),
  );
  const detach = useMutation(trpc.boards.detach.mutationOptions({ onSuccess: refresh }));
  // F-097/c2: applies at once, as "Start from Linear" does; `Save mapping` stays the mapping's.
  const promptTickets = useMutation(trpc.projects.setPromptTickets.mutationOptions({ onSuccess: refresh, onError: refresh }));
  const save = useMutation(
    trpc.boards.saveMapping.mutationOptions({
      onSuccess: async (_, input) => {
        setEdits((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== input.boardId)));
        setSaved(true);
        await refresh();
      },
    }),
  );

  const view = boards.data;
  const board = view?.boards.find((item) => item.id === params.get("board")) ?? view?.boards[0];
  const mapping = board === undefined ? null : (edits[board.id] ?? board.mapping);
  const dirty = board !== undefined && mapping !== null && !sameMapping(mapping, board.mapping);
  const now = boards.dataUpdatedAt === 0 ? mounted : boards.dataUpdatedAt;
  const jiraBoard = board?.capabilities.statusGraph === true ? board : undefined;
  const workflow = useQuery({
    ...trpc.boards.workflow.queryOptions({ boardId: jiraBoard?.id ?? noBoard, ...(mapping === null ? {} : { mapping }) }),
    enabled: jiraBoard?.state.state === "attached",
  });
  const trackers = useQuery({ ...trpc.trackers.list.queryOptions(), enabled: jiraBoard !== undefined });
  const site = trackers.data?.connections.find((connection) => connection.id === jiraBoard?.connection.id)?.site ?? null;
  const workflowUrl = site === null ? null : `https://${site}/secure/admin/workflows/ListWorkflows.jspa`;

  return (
    <PageFrame
      crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("boards.title") }]}
      actions={
        canEdit && board !== undefined && mapping !== null ? (
          <Button
            variant="primary"
            disabled={!dirty || !mappingSavable(board, mapping) || save.isPending}
            onClick={() => { setSaved(false); save.mutate({ boardId: board.id, mapping }); }}
          >
            {save.isPending ? t("common.saving") : t("boards.save")}
          </Button>
        ) : undefined
      }
      properties={view === undefined ? <Skeleton className="w-[200px]" /> : <BoardProperties view={view} board={board} mapping={mapping} now={now} {...(workflow.data === undefined ? {} : { workflow: workflow.data })} />}
    >
      <PageHeading title={t("boards.title")} lede={t("boards.lede")}>
        {view !== undefined && !view.canEdit ? <p className="mt-1 text-xs text-faint">{t("boards.readOnly")}</p> : null}
      </PageHeading>
      {boards.isError ? (
        <p role="alert" className="mt-6 flex items-start gap-2 text-ui text-red">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {errorText(boards.error)}
        </p>
      ) : view === undefined ? (
        <div className="max-w-[760px]">
          <Section title={t("boards.attached.title")}>
            <LoadingRows rows={2} height="h-12" />
          </Section>
          <Section title={t("boards.promptTickets.title")}>
            <LoadingRows rows={1} height="h-12" />
          </Section>
          <Section title={t("boards.mapping.title")}>
            <LoadingRows rows={5} height="h-12" />
          </Section>
        </div>
      ) : view.connections.length === 0 ? (
        <p className="mt-6 text-body text-muted" data-testid="boards-no-connection">
          {t("boards.noConnection")}{" "}
          {admin ? (
            <Link href="/organization/trackers" className="inline-flex items-center gap-1 text-teal hover:underline">
              {t("boards.connectTracker")}
              <ArrowRightIcon aria-hidden className="size-[14px] stroke-[1.75]" />
            </Link>
          ) : (
            t("boards.askAdmin")
          )}
        </p>
      ) : (
        <div className="max-w-[760px]">
          <Section title={t("boards.attached.title")} count={view.boards.length} className="mt-6">
            {view.boards.length === 0 ? <p className="text-body text-muted">{t("boards.attached.none")}</p> : null}
            {view.boards.length === 0 ? null : (
              <AttachedRows view={view} selectedId={board?.id} onSelect={(item) => { select(item.id); }} onDetach={(item) => { detach.mutate({ boardId: item.id }); }} detaching={detach.isPending} now={now} />
            )}
            <PauseLines view={view} />
            {canEdit ? (
              <AttachPicker
                connections={attachable.data?.connections}
                pending={attach.isPending}
                error={errorText(attachable.error ?? attach.error ?? detach.error)}
                onAttach={(connectionId, externalId) => { attach.mutate({ projectId, connectionId, externalId }); }}
              />
            ) : null}
            {justAttached ? <p className="mt-2 text-ui text-muted">{t("boards.attached.justAttached")}</p> : null}
          </Section>
          <Section title={t("boards.promptTickets.title")}>
            <PromptTickets
              view={view}
              selected={board}
              pending={promptTickets.isPending}
              error={errorText(promptTickets.error)}
              organizationAdmin={admin}
              onSet={(boardId) => { promptTickets.mutate({ projectId, boardId }); }}
            />
          </Section>
          {board === undefined ? null : (
            <Section
              title={t("boards.mapping.title")}
              className="mt-7"
              note={board.key === null ? board.name : `${board.name} · ${board.key}`}
            >
              <p className="mb-3 text-ui text-muted">{t(isJira(board) ? "boards.jira.note" : "boards.mapping.note", { key: board.key ?? board.name })}</p>
              {board.statusesError === null ? null : <p role="alert" className="mb-3 text-ui text-red">{t("boards.mapping.statusesError", { reason: board.statusesError })}</p>}
              {mapping === null ? (
                <p className="text-body text-muted">{t("boards.mapping.noMapping")}</p>
              ) : (
                <>
                  {board.capabilities.statusGraph ? (
                    <JiraMapping
                      board={board}
                      mapping={mapping}
                      canEdit={canEdit && board.state.state === "attached"}
                      workflow={workflow.data}
                      workflowError={workflow.error === null ? null : errorText(workflow.error)}
                      workflowUrl={workflowUrl}
                      onChange={(next) => { setSaved(false); setEdits((all) => ({ ...all, [board.id]: next })); }}
                    />
                  ) : (
                    <MappingForm board={board} mapping={mapping} canEdit={canEdit && board.state.state === "attached"} onChange={(next) => { setSaved(false); setEdits((all) => ({ ...all, [board.id]: next })); }} />
                  )}
                  <NextTask board={board} mapping={mapping} {...(workflow.data === undefined ? {} : { workflow: workflow.data })} />
                </>
              )}
              {save.error === null ? null : <p role="alert" className="mt-3 text-ui text-red">{errorText(save.error)}</p>}
              {saved && !dirty ? (
                <p role="status" className="mt-3 flex items-center gap-1.5 text-ui text-green">
                  <CheckIcon aria-hidden className="size-[14px] stroke-[1.75]" />
                  {t("boards.saved")}
                </p>
              ) : null}
            </Section>
          )}
        </div>
      )}
    </PageFrame>
  );
};
