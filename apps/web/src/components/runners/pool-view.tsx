"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, GlobeIcon, InfoIcon, MessageSquareIcon, PlusIcon, ShieldIcon, ZapIcon } from "lucide-react";
import Link from "next/link";
import { AlertDialog as Dialog } from "radix-ui";
import { useState } from "react";
import type { ReactNode } from "react";

import { PageFrame, PageHeading, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { carrierText, containmentText, poolLines, priorityOf, priorityText, queueReason, versionChip } from "./fleet-words";
import type { Priority } from "./fleet-words";
import { JoinTokenList } from "./join-token-list";
import { RunnerRowMenu } from "./runner-actions";
import { RunnerStatus } from "./runner-rows";
import { PoolSheet } from "./pool-sheet";
import type { FleetSettings, PoolSheetStep, SheetPool } from "./pool-sheet";

// F-092, F-067, F-091 (ticket 30, pool.md): one pool's page, for organization admins. Its runners,
// the projects that use it against their shares, its queue in order with Cancel, and in the panel
// its settings and join tokens. The live stream's refresh is a 5 s poll, as the Runners page's.

type Pool = RouterOutputs["pools"]["get"];
type Summary = RouterOutputs["pools"]["list"][number];
type Runner = RouterOutputs["runners"]["list"][number];
type Queued = RouterOutputs["pools"]["queue"][number];

const LIVE_MS = 5_000;

const stateOrder: Record<Runner["state"], number> = { online: 0, draining: 1, joining: 2, offline: 3, revoked: 4 };

/** Online, draining, joining, offline, then by name; revoked runners aren't listed. */
export const poolRunnerOrder = <R extends Pick<Runner, "state" | "name">,>(runners: readonly R[]): readonly R[] =>
  runners.filter((runner) => runner.state !== "revoked").toSorted((a, b) => stateOrder[a.state] - stateOrder[b.state] || a.name.localeCompare(b.name));

/** `{cap or slots}`: the pool's cap when it's lower than its working runners' slots. */
export const poolCapacity = (maxBoxes: number | null, slots: number): number => (maxBoxes !== null && maxBoxes < slots ? maxBoxes : slots);

const th = "h-[30px] whitespace-nowrap pr-3 text-left text-[12.5px] font-normal text-faint";
const row = "h-[38px] border-b border-line";

const Table = ({ label, minWidth, head, children }: { readonly label: string; readonly minWidth: number; readonly head: ReactNode; readonly children: ReactNode }) => (
  <div className="relative overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
    <table className="w-full border-collapse text-ui" style={{ minWidth }}>
      <thead>
        <tr className="border-b border-line">{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

const Empty = ({ cols, children }: { readonly cols: number; readonly children: ReactNode }) => (
  <tr className={row}>
    <td colSpan={cols} className="px-2 text-muted">{children}</td>
  </tr>
);

const LoadingRows = ({ cols }: { readonly cols: number }) => (
  <>
    {[0, 1, 2].map((i) => (
      <tr key={i} className={row} aria-busy>
        {Array.from({ length: cols }, (_, j) => (
          <td key={j} className="pr-3"><Skeleton className="w-[70%]" /></td>
        ))}
      </tr>
    ))}
  </>
);

const LabelChips = ({ labels }: { readonly labels: readonly string[] }) => {
  if (labels.length === 0) return <span className="text-faint">—</span>;
  const shown = labels.slice(0, 2);
  return (
    <span className="flex items-center gap-1.5">
      {shown.map((label) => <Chip key={label} className="font-mono text-[12.5px] text-text">{label}</Chip>)}
      {labels.length > 2 ? <span className="font-mono text-[12.5px] text-faint">+{labels.length - 2}</span> : null}
    </span>
  );
};

/** The pool's runners (pool.md, "Runners"). */
const RunnersTable = ({ pool, runners }: { readonly pool: Pool; readonly runners: readonly Runner[] | undefined }) => (
  <Table
    label={t("runners.runnersSection")}
    minWidth={700}
    head={
      <>
        <th className={cn(th, "pl-2")}>{t("runners.col.state")}</th>
        <th className={th}>{t("runners.pool.col.runner")}</th>
        <th className={th}>{t("runners.pool.col.carrier")}</th>
        <th className={th}>{t("runners.pool.col.containment")}</th>
        <th className={th}>{t("runners.pool.col.labels")}</th>
        <th className={th}>{t("runners.col.busy")}</th>
        <th className={th}>{t("runners.col.version")}</th>
        <th className={cn(th, "w-[30px] pr-0")}><span className="sr-only">{t("runner.actions")}</span></th>
      </>
    }
  >
    {runners === undefined ? <LoadingRows cols={8} /> : null}
    {runners?.length === 0 ? <Empty cols={8}>{t("runners.pool.noRunners", { pool: pool.name })}</Empty> : null}
    {runners?.map((runner) => {
      const chip = versionChip(runner.versionState);
      const idle = runner.state === "joining" || runner.state === "offline";
      const old = runner.minor !== null && runner.minor < 4 && runner.executor === "docker";
      return (
        <tr key={runner.id} data-runner={runner.name} className={cn(row, "group hover:bg-sel")}>
          <td className="whitespace-nowrap pl-2 pr-3">
            {runner.awaitingApproval ? <RunnerStatus state="joining" text={t("runners.pool.waitingApproval")} /> : <RunnerStatus state={runner.state} />}
          </td>
          <td className="pr-3">
            <Link href={`/organization/runners/${runner.id}`} className="truncate font-mono text-text hover:underline">{runner.name}</Link>
          </td>
          <td className="whitespace-nowrap pr-3 text-muted">{runner.connection === null ? "—" : carrierText(runner.connection.carrier)}</td>
          <td className="whitespace-nowrap pr-3 text-muted">
            <span className="inline-flex items-center gap-1.5">
              {containmentText(runner.processContainment).toLowerCase()}
              {runner.processContainment === "process-tree" ? (
                <Tooltip content={t("runners.pool.treeTip")}>
                  <InfoIcon aria-label={t("runners.pool.treeTip")} className="size-[13px] stroke-[1.75] text-faint" />
                </Tooltip>
              ) : null}
            </span>
          </td>
          <td className="pr-3"><LabelChips labels={runner.labels} /></td>
          <td className="whitespace-nowrap pr-3 font-mono text-muted">
            {idle ? "—" : old ? (
              <Tooltip content={t("runners.pool.sizesNotEnforced")}>
                <span>{t("runners.busyOf", { busy: runner.busy, slots: runner.slots })}</span>
              </Tooltip>
            ) : t("runners.busyOf", { busy: runner.busy, slots: runner.slots })}
          </td>
          <td className="whitespace-nowrap pr-3">
            <span className="flex items-center gap-2 font-mono text-muted">
              v{runner.version}
              {chip === null ? null : <Chip className="font-sans text-[12px]">{chip}</Chip>}
            </span>
          </td>
          <td className="pr-0 text-right opacity-100 xl:opacity-0 xl:group-focus-within:opacity-100 xl:group-hover:opacity-100">
            <RunnerRowMenu runner={{ id: runner.id, name: runner.name, kind: runner.kind, state: runner.state, busy: runner.busy, minor: runner.minor, awaitingApproval: runner.awaitingApproval, poolName: pool.name }} />
          </td>
        </tr>
      );
    })}
  </Table>
);

/** The `.meter`: 120 × 4px, Mist on `--line-2`. */
const Meter = ({ value, max }: { readonly value: number; readonly max: number }) => (
  <span role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="relative inline-block h-1 w-[120px] shrink-0 overflow-hidden rounded-full bg-line-2">
    <span className="absolute inset-y-0 left-0 rounded-full bg-meter" style={{ width: `${String(max === 0 ? 0 : Math.min(100, (value / max) * 100))}%` }} />
  </span>
);

/** The projects that use the pool, against their shares (pool.md, "Projects"). */
const ProjectsTable = ({ pool, cap, queue }: { readonly pool: Pool; readonly cap: number; readonly queue: readonly Queued[] | undefined }) => (
  <Table
    label={t("runners.pool.projects")}
    minWidth={600}
    head={
      <>
        <th className={cn(th, "pl-2")}>{t("runners.pool.col.project")}</th>
        <th className={cn(th, "w-[230px]")}>{t("runners.pool.col.boxes")}</th>
        <th className={cn(th, "w-[220px]")}>{t("runners.pool.col.share")}</th>
        <th className={cn(th, "w-[80px]")}>{t("runners.pool.col.queued")}</th>
      </>
    }
  >
    {pool.projects.length === 0 ? <Empty cols={4}>{t("runners.pool.noProjects", { pool: pool.name })}</Empty> : null}
    {pool.projects.map((project) => {
      const atShare = project.maxBoxes !== null && project.busy >= project.maxBoxes;
      return (
        <tr key={project.projectId} data-project={project.name} className={row}>
          <td className="pl-2 pr-3">
            <Link href={`/projects/${project.projectId}/settings/runners`} className="flex items-center gap-2.5 text-text hover:underline">
              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.projectId) }} />
              <span className="truncate">{project.name}</span>
            </Link>
          </td>
          <td className="pr-3">
            <span className="flex items-center gap-3">
              <Meter value={project.busy} max={project.maxBoxes ?? cap} />
              <span className="whitespace-nowrap font-mono text-text">{project.maxBoxes === null ? project.busy : `${String(project.busy)} / ${String(project.maxBoxes)}`}</span>
            </span>
          </td>
          <td className="pr-3">
            {project.maxBoxes === null ? (
              <span className="text-faint">{t("runners.pool.noShare")}</span>
            ) : (
              <span className="flex items-center gap-2 text-text">
                {t("runners.pool.shareBoxes", { n: project.maxBoxes })}
                {atShare ? <Chip>{t("runners.pool.atShare")}</Chip> : null}
              </span>
            )}
          </td>
          <td className="pr-3 font-mono text-text">{queue === undefined ? "—" : queue.filter((entry) => entry.project.id === project.projectId).length}</td>
        </tr>
      );
    })}
  </Table>
);

const PriorityIcon = ({ priority }: { readonly priority: Priority }) => {
  const cls = "size-[14px] shrink-0 stroke-[1.75] text-muted";
  switch (priority) {
    case "urgent":
      return <ZapIcon aria-hidden className={cls} />;
    case "high":
      return <ArrowUpIcon aria-hidden className={cls} />;
    case "medium":
      return <ArrowRightIcon aria-hidden className={cls} />;
    case "low":
      return <ArrowDownIcon aria-hidden className={cls} />;
    default:
      return priority satisfies never;
  }
};

/** Cancel a queued task: it stops as cancelled before it starts (pool.md, "Queue"). */
const CancelQueued = ({ entry }: { readonly entry: Queued }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const cancel = useMutation(
    trpc.tasks.cancelQueued.mutationOptions({
      onSettled: () => Promise.all([queryClient.invalidateQueries({ queryKey: trpc.pools.pathKey() }), queryClient.invalidateQueries({ queryKey: trpc.tasks.pathKey() })]),
    }),
  );
  const started = cancel.error?.data?.code === "CONFLICT";
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!cancel.isPending) { setOpen(next); if (!next) cancel.reset(); } }}>
      <Dialog.Trigger className="text-ui text-teal hover:underline">{t("runners.queue.cancel")}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-(--scrim)" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line-2 bg-raise p-5 shadow-(--shadow-pop) focus:outline-none">
          <Dialog.Title className="text-[16.5px] font-semibold text-text">{t("runners.queue.cancelTitle")}</Dialog.Title>
          <Dialog.Description className="mt-1.5 text-body text-muted">
            {entry.ticketKey === null ? t("runners.queue.cancelBodyPrompt") : t("runners.queue.cancelBody", { key: entry.ticketKey })}
          </Dialog.Description>
          {cancel.error === null ? null : <p role="alert" className="mt-3 text-sm text-red">{started ? t("runners.queue.started") : errorText(cancel.error)}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Cancel className={buttonVariants()} disabled={cancel.isPending}>{started ? t("common.close") : t("runners.queue.keep")}</Dialog.Cancel>
            {started ? null : (
              <button
                type="button"
                className={buttonVariants({ variant: "danger" })}
                disabled={cancel.isPending}
                onClick={() => { cancel.mutate({ taskId: entry.taskId }, { onSuccess: () => { setOpen(false); cancel.reset(); } }); }}
              >
                {t("runners.queue.cancelTask")}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/** The queue in order (pool.md, "Queue"): place, priority, task, project, waiting, why and Cancel. */
const QueueTable = ({ pool, busy, cap, queue, now }: { readonly pool: Pool; readonly busy: number; readonly cap: number; readonly queue: readonly Queued[] | undefined; readonly now: number }) => {
  const [all, setAll] = useState(false);
  const shown = queue === undefined ? undefined : all ? queue : queue.slice(0, 50);
  return (
    <>
      <Table
        label={t("runners.pool.queue")}
        minWidth={700}
        head={
          <>
            <th className={cn(th, "w-[32px] pl-2")}>{t("runners.queue.col.place")}</th>
            <th className={cn(th, "w-[96px] max-sm:hidden")}>{t("runners.queue.col.priority")}</th>
            <th className={th}>{t("runners.queue.col.task")}</th>
            <th className={cn(th, "w-[136px]")}>{t("runners.pool.col.project")}</th>
            <th className={cn(th, "w-[60px] text-right")}>{t("runners.queue.col.waiting")}</th>
            <th className={cn(th, "w-[160px] pl-4 max-sm:hidden")}>{t("runners.queue.col.why")}</th>
            <th className={cn(th, "w-[60px]")}><span className="sr-only">{t("runners.queue.cancel")}</span></th>
          </>
        }
      >
        {shown === undefined ? <LoadingRows cols={7} /> : null}
        {shown?.length === 0 ? <Empty cols={7}>{t("runners.queue.empty", { pool: pool.name })}</Empty> : null}
        {shown?.map((entry) => {
          const priority = priorityOf(entry.priority);
          const why = queueReason(entry.waitReason, { name: pool.name, busy, cap }, entry.project.name);
          return (
            <tr key={entry.taskId} data-queued={entry.ticketKey ?? entry.title} className={cn(row, "max-sm:h-[52px]")}>
              <td className="pl-2 pr-3 font-mono text-faint">{entry.place}</td>
              <td className="pr-3 max-sm:hidden">
                <span className="flex items-center gap-2 text-text"><PriorityIcon priority={priority} />{priorityText(priority)}</span>
              </td>
              <td className="max-w-0 pr-3">
                <Link href={`/tasks/${entry.taskId}`} className="flex min-w-0 items-center gap-2.5 hover:underline">
                  <span className="sm:hidden"><PriorityIcon priority={priority} /></span>
                  {entry.ticketKey === null ? (
                    <MessageSquareIcon aria-label={t("runners.queue.prompt")} className="size-[14px] shrink-0 stroke-[1.75] text-faint" />
                  ) : (
                    <span className="shrink-0 font-mono text-faint">{entry.ticketKey}</span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-text">{entry.title}</span>
                    <span className="block truncate text-[12.5px] text-faint sm:hidden">{why.short}</span>
                  </span>
                </Link>
              </td>
              <td className="pr-3">
                <span className="flex items-center gap-2.5 text-text">
                  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(entry.project.id) }} />
                  <span className="truncate">{entry.project.name}</span>
                </span>
              </td>
              <td className="pr-3 text-right font-mono text-faint">{entry.queuedAt === null ? "—" : formatAge(entry.queuedAt, now).replace("now", "0m")}</td>
              <td className="pl-4 pr-3 text-[13.5px] text-muted max-sm:hidden">
                <Tooltip content={why.full}>
                  <span className="block truncate">{why.short}</span>
                </Tooltip>
              </td>
              <td className="pr-2 text-right"><CancelQueued entry={entry} /></td>
            </tr>
          );
        })}
      </Table>
      {queue !== undefined && queue.length > 50 && !all ? (
        <Button variant="ghost" className="mt-2" onClick={() => { setAll(true); }}>{t("runners.queue.showAll", { n: queue.length })}</Button>
      ) : null}
    </>
  );
};

/** The approval switch: it saves at once, and flips back on a failure. */
const ApprovalSwitch = ({ pool, onError }: { readonly pool: Pool; readonly onError: (message: string | null) => void }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const update = useMutation(
    trpc.pools.update.mutationOptions({
      onError: (error) => { setOptimistic(null); onError(errorText(error)); },
      onSuccess: async () => {
        onError(null);
        await queryClient.invalidateQueries({ queryKey: trpc.pools.pathKey() });
        setOptimistic(null);
      },
    }),
  );
  const on = optimistic ?? pool.requiresApproval;
  return (
    <Tooltip content={t("runners.pool.approvalTip")}>
      <span className="flex items-center gap-2.5">
        <Switch
          aria-label={t("runners.poolRequiresApproval")}
          checked={on}
          disabled={update.isPending}
          onCheckedChange={(next) => { setOptimistic(next); update.mutate({ poolId: pool.id, requiresApproval: next }); }}
        />
        {on ? t("runners.pool.required") : t("runners.approvalNotRequired")}
      </span>
    </Tooltip>
  );
};

const projectsText = (pool: Pool): string => {
  const first = pool.projects[0];
  if (first === undefined) return t("runners.noProjects");
  return pool.projects.length > 1 ? t("runners.moreProjects", { name: first.name, n: pool.projects.length - 1 }) : first.name;
};

const PoolPanel = ({ pool, summary, defaultDays, onEdit }: { readonly pool: Pool; readonly summary: Summary | undefined; readonly defaultDays: number; readonly onEdit: () => void }) => {
  const [switchError, setSwitchError] = useState<string | null>(null);
  const v = (node: ReactNode) => (summary === undefined ? <Skeleton className="w-16" /> : node);
  // The default reads as its number of days (pool.md, pool-new.md): `OSTRA_JOIN_TOKEN_DAYS`, 30 unless set.
  const days = pool.joinTokenDays ?? defaultDays;
  const lifetime = days === 0 ? t("runners.pool.noExpiry") : t("runners.poolForm.days", { n: days });
  return (
    <div data-testid="pool-panel">
      <PropGroup title={t("runners.pool.panelPool")}>
        <PropRow label={t("runners.prop.executor")} labelWidth={110}>{v(<span className="font-mono">{summary?.executors.length === 0 ? "—" : summary?.executors.join(", ")}</span>)}</PropRow>
        <PropRow label={t("runners.prop.runners")} labelWidth={110}>{v(<span className="font-mono">{t("runners.onlineCount", { online: summary?.onlineCount ?? 0, total: summary?.runnerCount ?? 0 })}</span>)}</PropRow>
        <PropRow label={t("runners.prop.busy")} labelWidth={110}>{v(<span className="font-mono">{t("runners.boxesOf", { busy: summary?.busy ?? 0, slots: poolCapacity(pool.maxBoxes, summary?.slots ?? 0) })}</span>)}</PropRow>
        <PropRow label={t("runners.pool.queueKey")} labelWidth={110}>{v(summary?.queueLength === 0 ? t("runners.pool.nothingWaiting") : <span className="font-mono">{t("runners.pool.waiting", { n: summary?.queueLength ?? 0 })}</span>)}</PropRow>
      </PropGroup>
      <div className="mb-3.5 border-b border-line pb-3.5">
        <div className="mb-2 flex items-center">
          <h3 className="text-xs font-medium text-faint">{t("runners.pool.settings")}</h3>
          <button type="button" className="ml-auto text-ui text-teal hover:underline" onClick={onEdit}>{t("runners.pool.edit")}</button>
        </div>
        {switchError === null ? null : <p role="alert" className="mb-2 text-sm text-red">{switchError}</p>}
        <PropRow label={t("runners.prop.approval")} labelWidth={110}><ApprovalSwitch pool={pool} onError={setSwitchError} /></PropRow>
        <PropRow label={t("runners.prop.maxBoxes")} labelWidth={110}>{pool.maxBoxes === null ? t("runners.noLimit") : <span className="font-mono">{pool.maxBoxes}</span>}</PropRow>
        <PropRow label={t("runners.pool.lifetime")} labelWidth={110}>{lifetime}</PropRow>
        <PropRow label={t("runners.prop.projects")} labelWidth={110}><span className="truncate">{projectsText(pool)}</span></PropRow>
      </div>
      <JoinTokenList poolId={pool.id} poolName={pool.name} />
    </div>
  );
};

/** The lede: `3 runners, 24 of 24 boxes busy, 6 tasks waiting.` */
export const poolLede = (runners: number, busy: number, cap: number, queued: number): string => {
  const waiting = queued === 0 ? t("runners.pool.ledeNothing") : queued === 1 ? t("runners.pool.ledeOneWaiting") : t("runners.pool.ledeWaiting", { n: queued });
  if (runners === 0) return t("runners.pool.ledeNoRunner", { waiting });
  return t("runners.pool.lede", { runners: runners === 1 ? t("runners.pool.oneRunner") : t("runners.pool.runners", { n: runners }), busy, cap, waiting });
};

export const PoolView = ({ poolId, settings }: { readonly poolId: string; readonly settings: FleetSettings }) => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const pool = useQuery({ ...trpc.pools.get.queryOptions({ poolId }), refetchInterval: LIVE_MS, retry: (count, error) => error.data?.code !== "NOT_FOUND" && count < 2 });
  const pools = useQuery({ ...trpc.pools.list.queryOptions(), refetchInterval: LIVE_MS });
  const runners = useQuery({ ...trpc.runners.list.queryOptions(), refetchInterval: LIVE_MS });
  const queue = useQuery({ ...trpc.pools.queue.queryOptions({ poolId }), refetchInterval: LIVE_MS });
  const [step, setStep] = useState<PoolSheetStep | null>(null);
  const [opening, setOpening] = useState(0);
  const now = Date.now();

  const organization = me.data?.organization?.name ?? t("shell.organization");
  const crumbs = [{ label: organization }, { label: t("shell.runners"), href: "/organization/runners" }, { label: pool.data?.name ?? "…" }];
  if (pool.error?.data?.code === "NOT_FOUND") {
    return (
      <PageFrame crumbs={crumbs.slice(0, 2)}>
        <PageHeading title={t("runners.pool.notFoundTitle")} lede={t("runners.pool.notFound")} />
      </PageFrame>
    );
  }
  const summary = pools.data?.find((one) => one.id === poolId);
  const data = pool.data;
  const listed = runners.data === undefined ? undefined : poolRunnerOrder(runners.data.filter((runner) => runner.pool?.id === poolId));
  const cap = data === undefined ? 0 : poolCapacity(data.maxBoxes, summary?.slots ?? 0);
  const sheetPool: SheetPool | null = data === undefined ? null : { id: data.id, name: data.name, requiresApproval: data.requiresApproval, maxBoxes: data.maxBoxes, joinTokenDays: data.joinTokenDays, executors: summary?.executors ?? [] };
  const open = (next: PoolSheetStep) => { setOpening(opening + 1); setStep(next); };
  const executors = summary?.executors ?? [];

  return (
    <Sheet open={step !== null} onOpenChange={(next) => { if (!next) setStep(null); }}>
      <PageFrame
        crumbs={[{ label: organization }, { label: t("shell.runners"), href: "/organization/runners" }, { label: data?.name ?? "…" }]}
        actions={
          <Button variant="primary" disabled={sheetPool === null} onClick={() => { if (sheetPool !== null) open({ kind: "new-token", pool: sheetPool }); }}>
            <PlusIcon className="stroke-[1.75]" /> {t("runners.newToken")}
          </Button>
        }
        properties={data === undefined ? <Skeleton className="w-3/4" /> : <PoolPanel pool={data} summary={summary} defaultDays={settings.joinTokenDays} onEdit={() => { if (sheetPool !== null) open({ kind: "edit", pool: sheetPool }); }} />}
      >
        <div className="mb-2">
          <div className="my-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="page-title break-words">{data?.name ?? ""}</h1>
            {executors.map((executor) => <Chip key={executor} className="font-mono text-[13px]">{executor}</Chip>)}
            {data?.isDefault === true ? <Chip className="font-mono text-[13px]">{t("runners.defaultPool")}</Chip> : null}
          </div>
          {data === undefined || summary === undefined ? (
            <Skeleton className="mt-2 h-4 w-[320px]" />
          ) : (
            <p className="text-lede text-muted">{poolLede(summary.runnerCount, summary.busy, cap, summary.queueLength)}</p>
          )}
          {poolLines(summary?.lines ?? []).map((line) => (
            <p key={line.text} className="mt-2 flex items-start gap-2 text-sm text-faint">
              {line.icon === "globe" ? <GlobeIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" /> : <ShieldIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />}
              {line.text}
            </p>
          ))}
        </div>
        {data === undefined ? null : (
          <>
            <Section title={t("runners.runnersSection")} {...(listed === undefined ? {} : { count: listed.length })}>
              <RunnersTable pool={data} runners={listed} />
            </Section>
            <Section title={t("runners.pool.projects")} count={data.projects.length}>
              <ProjectsTable pool={data} cap={cap} queue={queue.data} />
            </Section>
            <Section title={t("runners.pool.queue")} {...(queue.data === undefined ? {} : { count: queue.data.length })} end={<span className="hidden text-faint sm:inline">{t("runners.queue.order")}</span>}>
              <QueueTable pool={data} busy={summary?.busy ?? 0} cap={cap} queue={queue.data} now={now} />
            </Section>
          </>
        )}
      </PageFrame>
      {step === null ? null : <PoolSheet key={opening} step={step} settings={settings} onClose={() => { setStep(null); }} poolHref={null} />}
    </Sheet>
  );
};
