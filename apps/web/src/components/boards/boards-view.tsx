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
  SquareKanbanIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow, Section } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Dot } from "@/components/ui/status";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import {
  groupStatuses,
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
  statusTypeOf,
} from "./board-words";
import type { BoardView, BoardsData, Mapping, StatusType } from "./board-words";

type Team = RouterOutputs["boards"]["available"][number];

const icon = "size-[15px] shrink-0 stroke-[1.75] text-muted";

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
  return status === undefined ? "other" : statusTypeOf(status);
};

/** A status as a value: its icon and name; a gone one in red, struck through. */
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
const Activity = ({ board, mode, now }: { readonly board: BoardView; readonly mode: "webhooks" | "polling"; readonly now: number }) =>
  mode === "webhooks" && board.lastEvent !== null ? (
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

export type AttachedRowsProps = {
  readonly view: BoardsData;
  readonly selectedId: string | undefined;
  readonly onSelect: (board: BoardView) => void;
  readonly onDetach: (board: BoardView) => void;
  readonly detaching: boolean;
  readonly now: number;
  /** Milestone 6 (F-012): "Start from Linear" per board, while the organization's agent mode is on. */
  readonly agentMode?: { readonly onChange: (board: BoardView, on: boolean) => void; readonly pending: boolean };
};

/** The attached boards: one row each; a click selects it for the mapping and the panel. */
export const AttachedRows = ({ view, selectedId, onSelect, onDetach, detaching, now, agentMode }: AttachedRowsProps) => (
  <ul data-testid="boards" className="border-t border-line">
    {view.boards.map((board) => (
      <li
        key={board.id}
        data-selected={board.id === selectedId}
        className={cn(
          "grid min-h-[38px] grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-2 sm:grid-cols-[24px_minmax(0,1fr)_72px_140px_minmax(0,1fr)_auto]",
          board.id === selectedId ? "rounded-md bg-sel" : "hover:bg-hover",
        )}
      >
        <SquareKanbanIcon aria-hidden className="size-[15px] stroke-[1.75] text-faint" />
        <button type="button" onClick={() => { onSelect(board); }} aria-pressed={board.id === selectedId} className="truncate text-left text-body font-medium text-text">
          {board.name}
        </button>
        <span className="hidden font-mono text-ui text-faint sm:block">{board.key ?? "–"}</span>
        <span className="hidden text-ui text-muted sm:block">
          <span className="font-mono">{board.openTickets}</span> {plural(board.openTickets, "boards.attached.tickets.one", "boards.attached.tickets.other")}
        </span>
        <span className="hidden min-w-0 sm:block">{view.connection === null ? null : <Activity board={board} mode={view.connection.mode} now={now} />}</span>
        <span className="flex items-center gap-2">
        {view.connection?.agentMode === true && agentMode !== undefined ? (
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="hidden md:inline">{t("agentMode.boardsTitle")}</span>
            <Switch
              checked={board.startFromLinear}
              disabled={!view.canEdit || agentMode.pending}
              aria-label={t("agentMode.boardSwitch", { board: board.name })}
              onCheckedChange={(on) => { agentMode.onChange(board, on); }}
            />
          </label>
        ) : null}
        {view.canEdit ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={detaching}>
                {t("boards.attached.detach")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent
              title={t("boards.attached.detachTitle", { name: board.name })}
              body={t("boards.attached.detachBody", { key: board.key ?? board.name })}
              cancel={t("common.cancel")}
              action={t("boards.attached.detach")}
              onAction={() => { onDetach(board); }}
            />
          </AlertDialog>
        ) : (
          <span />
        )}
        </span>
      </li>
    ))}
  </ul>
);

/** The Attach line: the connection's teams, those on this project disabled, then Attach. */
export const AttachLine = ({ teams, onAttach, pending, error }: { readonly teams: readonly Team[] | undefined; readonly onAttach: (team: Team) => void; readonly pending: boolean; readonly error: string | null }) => {
  const [picked, setPicked] = useState<string>("");
  const free = teams?.filter((team) => !team.attached) ?? [];
  const team = teams?.find((item) => item.externalId === picked && !item.attached);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ui text-muted">{t("boards.attached.attachLabel")}</span>
        <Select value={team === undefined ? "" : picked} onValueChange={setPicked} disabled={teams === undefined || free.length === 0 || pending}>
          <SelectTrigger aria-label={t("boards.attached.attachLabel")} className="h-[30px] w-[260px]">
            <SelectValue placeholder={teams !== undefined && free.length === 0 ? t("boards.attached.noTeams") : t("boards.attached.pick")} />
          </SelectTrigger>
          <SelectContent align="start">
            {teams?.map((item) => (
              <SelectItem key={item.externalId} value={item.externalId} disabled={item.attached}>
                <span>{item.name}</span>
                <span className="font-mono text-sm text-muted">· {item.key}</span>
                {item.attached ? (
                  <span className="text-sm text-faint">{t("boards.attached.alreadyAttached")}</span>
                ) : item.alsoOn[0] === undefined ? null : (
                  <span className="truncate text-sm text-faint">{t("boards.attached.alsoOn", { name: item.alsoOn[0].name })}</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button disabled={team === undefined || pending} onClick={() => { if (team !== undefined) onAttach(team); }}>
          {pending ? t("boards.attached.attaching") : t("boards.attached.attach")}
        </Button>
      </div>
      {error === null ? null : <p role="alert" className="mt-2 text-ui text-red">{error}</p>}
    </div>
  );
};

/** One step's single-status picker, every status of the team grouped by type. */
const StatusSelect = ({ board, value, onChange, label }: { readonly board: BoardView; readonly value: string; readonly onChange: (id: string) => void; readonly label: string }) => (
  <Select value={value} onValueChange={onChange}>
    <SelectTrigger aria-label={label} className="h-[34px] w-full max-w-[400px]">
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
    <div className="flex min-h-[34px] w-full max-w-[400px] items-center gap-1.5 rounded-md border border-line-2 bg-surface py-1 pl-1.5 pr-1">
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
        {/* No statuses read from Linear: nothing to add, so the button rests rather than open an empty panel that holds the focus. */}
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
  <div className="grid min-h-12 grid-cols-1 items-center gap-x-4 gap-y-1.5 border-b border-line py-2 sm:grid-cols-[200px_minmax(0,1fr)]">
    <div>
      <div className="text-body font-medium text-text">{name}</div>
      {hint === undefined ? null : <div className={cn("text-xs", hintRed ? "text-red" : "text-faint")}>{hint}</div>}
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

/** The status mapping: the four steps' statuses, who moves done, the magic word. */
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
    </div>
  );
};

/** What the next task does on the ticket, one numbered sentence per step, from the unsaved mapping. */
export const NextTask = ({ board, mapping }: { readonly board: BoardView; readonly mapping: Mapping }) => (
  <div className="mt-6" data-testid="next-task">
    <p className="mb-1.5 text-sm text-muted">{t("boards.next.title")}</p>
    <ol className="space-y-1">
      {nextTaskLines(board, mapping).map((line, i) => {
        const [before = "", after = ""] = line.text.split("{status}");
        return (
          <li key={line.text} className="grid grid-cols-[28px_minmax(0,1fr)] text-ui text-muted">
            <span className="font-mono text-faint">{i + 1}</span>
            <span>
              {before}
              <b className="font-medium text-text">{line.status}</b>
              {after}
            </span>
          </li>
        );
      })}
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

/** The panel: the selected board, the connection, and the team's statuses with the step each maps to. */
export const BoardProperties = ({ view, board, mapping, now }: { readonly view: BoardsData; readonly board: BoardView | undefined; readonly mapping: Mapping | null; readonly now: number }) => {
  const connection = view.connection;
  return (
    <div data-testid="board-properties">
      {board === undefined || connection === null ? null : (
        <>
          <PanelLabel>{t("boards.panel.board")}</PanelLabel>
          <PropRow label={t("boards.panel.team")}>{board.name}</PropRow>
          <PropRow label={t("boards.panel.key")}>
            <span className="font-mono">{board.key ?? "–"}</span>
          </PropRow>
          <PropRow label={t("boards.panel.tickets")}>{t("boards.panel.openCount", { n: board.openTickets })}</PropRow>
          <PropRow label={t("boards.panel.mode")}>
            <Dot tone={connection.mode === "webhooks" ? "green" : "grey"} />
            {connection.mode === "webhooks" ? t("boards.panel.webhooks") : t("boards.panel.polling", { seconds: connection.pollSeconds })}
          </PropRow>
          <PropRow label={t("boards.panel.lastEvent")}>
            <span className="font-mono">{board.lastEvent === null ? "–" : t("boards.attached.ago", { age: shortAge(board.lastEvent.at, now) })}</span>
          </PropRow>
          <PropRow label={t("boards.panel.attached")}>
            <span className="font-mono">{day(board.attachedAt)}</span>
          </PropRow>
          <Sep />
        </>
      )}
      {connection === null ? null : (
        <>
          <PanelLabel>{t("boards.panel.linear")}</PanelLabel>
          <PropRow label={t("boards.panel.workspace")}>{connection.workspaceName ?? "–"}</PropRow>
          {board === undefined ? null : (
            <PropRow label={t("boards.panel.github")}>
              {board.integration === "installed" ? (
                <>
                  <CircleCheckIcon aria-hidden className="text-green!" />
                  {t("boards.panel.installed")}
                </>
              ) : board.integration === "not_installed" ? (
                t("boards.panel.notInstalled")
              ) : (
                t("boards.panel.unknown")
              )}
            </PropRow>
          )}
        </>
      )}
      {board === undefined ? null : (
        <>
          <Sep />
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
};

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

/** Project › Boards (F-007, F-031; project-boards.md): the attached Linear teams and their mapping. */
export const BoardsView = ({ projectId, admin }: { readonly projectId: ProjectId; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const boards = useQuery(trpc.boards.get.queryOptions({ projectId }));
  const canEdit = boards.data?.canEdit === true;
  const available = useQuery({ ...trpc.boards.available.queryOptions({ projectId }), enabled: canEdit && boards.data?.connection !== null });
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
  const startFromLinear = useMutation(trpc.linear.setBoardAgentMode.mutationOptions({ onSuccess: refresh, onError: refresh }));
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
      properties={view === undefined ? <Skeleton className="w-[200px]" /> : <BoardProperties view={view} board={board} mapping={mapping} now={now} />}
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
            <LoadingRows rows={2} height="h-[38px]" />
          </Section>
          <Section title={t("boards.mapping.title")}>
            <LoadingRows rows={5} height="h-12" />
          </Section>
        </div>
      ) : view.connection === null ? (
        <p className="mt-6 text-body text-muted" data-testid="boards-no-connection">
          {t("boards.noConnection")}{" "}
          {admin ? (
            <Link href="/organization/linear" className="inline-flex items-center gap-1 text-teal hover:underline">
              {t("boards.connectLinear")}
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
              <AttachedRows view={view} selectedId={board?.id} onSelect={(item) => { select(item.id); }} onDetach={(item) => { detach.mutate({ boardId: item.id }); }} detaching={detach.isPending} now={now} agentMode={{ onChange: (item, on) => { startFromLinear.mutate({ boardId: item.id, on }); }, pending: startFromLinear.isPending }} />
            )}
            {canEdit ? (
              <AttachLine
                teams={available.data}
                pending={attach.isPending}
                error={errorText(available.error ?? attach.error ?? detach.error ?? startFromLinear.error)}
                onAttach={(team) => { attach.mutate({ projectId, teamExternalId: team.externalId }); }}
              />
            ) : null}
            {justAttached ? <p className="mt-2 text-ui text-muted">{t("boards.attached.justAttached")}</p> : null}
          </Section>
          {board === undefined ? null : (
            <Section
              title={t("boards.mapping.title")}
              className="mt-7"
              note={board.key === null ? board.name : `${board.name} · ${board.key}`}
            >
              <p className="mb-3 text-ui text-muted">{t("boards.mapping.note")}</p>
              {board.statusesError === null ? null : <p role="alert" className="mb-3 text-ui text-red">{t("boards.mapping.statusesError", { reason: board.statusesError })}</p>}
              {mapping === null ? (
                <p className="text-body text-muted">{t("boards.mapping.noMapping")}</p>
              ) : (
                <>
                  <MappingForm board={board} mapping={mapping} canEdit={canEdit} onChange={(next) => { setSaved(false); setEdits((all) => ({ ...all, [board.id]: next })); }} />
                  <NextTask board={board} mapping={mapping} />
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
