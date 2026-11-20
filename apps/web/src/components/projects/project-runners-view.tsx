"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, GripVerticalIcon, LaptopIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import type { BoxSizeName, PoolId, ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { AlertDialog, AlertDialogContent } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { tNodes } from "@/lib/message-nodes";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { ProjectSettingsTabs } from "./settings-tabs";
import { lastChangeOf, moveItem, parseShare, sizeValue } from "./project-runners-words";

type Runners = RouterOutputs["projects"]["runners"];
type Listed = Runners["pools"][number];
type Use = RouterOutputs["fleetUse"]["project"];
type PoolUse = Use["pools"][number];

const grid = "grid items-center gap-x-3 grid-cols-[56px_minmax(0,1fr)_150px_240px_64px]";
const phoneGrid = "max-sm:grid-cols-[56px_minmax(0,1fr)_auto] max-sm:gap-y-1.5 max-sm:py-2";

const ExecutorBadge = ({ executor }: { readonly executor: string }) => (
  <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-line-2 px-1.5 font-mono text-[11px] text-faint">{executor}</span>
);

/** The share meter (dataviz: one series, the count beside it is its label). Full at the share, never red. */
const ShareMeter = ({ project, pool, held, share }: { readonly project: string; readonly pool: string; readonly held: number; readonly share: number }) => {
  const ratio = share === 0 ? 1 : Math.min(1, held / share);
  return (
    <Tooltip content={held >= share ? t("projectRunners.meterAtShare", { project, held, share, pool }) : t("projectRunners.meterBelow", { project, held, share, pool })}>
      <span
        role="meter"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={share}
        aria-valuenow={held}
        aria-label={t("projectRunners.meterLabel", { project, pool })}
        className="relative block h-1.5 w-[120px] shrink-0 overflow-hidden rounded-[3px] bg-line"
      >
        <span className="absolute inset-y-0 left-0 rounded-[3px] bg-meter" style={{ width: held === 0 ? 0 : `max(4px, ${String(ratio * 100)}%)` }} />
      </span>
    </Tooltip>
  );
};

/** The record without `key`. */
const withoutKey = (record: Readonly<Record<string, string>>, key: string): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

type Lift = { readonly from: number; readonly original: readonly Listed[] };

/**
 * A project's settings › Runners (F-086, F-095, F-069; project-runners.md): the pools ostra tries
 * in order, reordered by drag or keyboard, each share, the default box size, and the line on
 * personal runners. Every change applies at once; there's no Save.
 */
export const ProjectRunnersView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const runners = useQuery(trpc.projects.runners.queryOptions({ projectId }));
  const use = useQuery(trpc.fleetUse.project.queryOptions({ projectId }));
  const sizes = useQuery(trpc.boxSizes.list.queryOptions());
  const poolsChange = useQuery(trpc.audit.list.queryOptions({ projectId, action: "project.pools-set", limit: 1 }));
  const sizeChange = useQuery(trpc.audit.list.queryOptions({ projectId, action: "project.default-box-size-set", limit: 1 }));

  const [order, setOrder] = useState<readonly Listed[] | null>(null);
  const [lift, setLift] = useState<Lift | null>(null);
  const [live, setLive] = useState("");
  const [status, setStatus] = useState<{ readonly at: "pools" | "size"; readonly text: string } | null>(null);
  const [shares, setShares] = useState<Readonly<Record<string, string>>>({});
  const [shareError, setShareError] = useState<{ readonly poolId: string; readonly max: number } | null>(null);
  const [addPick, setAddPick] = useState("");
  const [removing, setRemoving] = useState<Listed | null>(null);
  const [dragging, setDragging] = useState<{ readonly poolId: string; readonly original: readonly Listed[] } | null>(null);
  const rowsRef = useRef<HTMLUListElement>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(() => { setStatus(null); }, 4000);
    return () => { clearTimeout(timer); };
  }, [status]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.projects.runners.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.fleetUse.project.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.fleetUse.boxSizes.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.audit.list.pathKey() }),
    ]);
  };
  const setPools = useMutation(trpc.projects.setPools.mutationOptions({ onSettled: async () => { setOrder(null); await refresh(); } }));
  const setSize = useMutation(trpc.projects.setDefaultBoxSize.mutationOptions({ onSettled: () => refresh() }));

  const name = project.data?.name ?? "";
  const orgAdmin = me.data?.organization?.role === "admin";
  const saved = runners.data?.pools ?? [];
  const pools = order ?? saved;
  const useOf = (poolId: string): PoolUse | undefined => use.data?.pools.find((pool) => pool.poolId === poolId);
  const savePools = (list: readonly Listed[], text: string) => {
    setStatus(null);
    setPools.mutate(
      { projectId, pools: list.map((pool) => ({ poolId: pool.poolId, maxBoxes: pool.maxBoxes })) },
      { onSuccess: () => { setStatus({ at: "pools", text }); } },
    );
  };

  // ---- reorder by keyboard (project-runners.md, "Reorder by keyboard") ----
  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const pool = pools[index];
    if (pool === undefined || pools.length < 2 || setPools.isPending) return;
    const count = pools.length;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (lift === null) {
        setLift({ from: index, original: pools });
        setOrder(pools);
        setLive(t("projectRunners.lifted", { pool: pool.name, position: index + 1, count }));
        return;
      }
      setLive(t("projectRunners.dropped", { pool: pool.name, position: index + 1, count }));
      setLift(null);
      const changed = pools.some((item, i) => item.poolId !== lift.original[i]?.poolId);
      if (changed) savePools(pools, t("projectRunners.savedOrder", { pool: pools[0]?.name ?? "" }));
      else setOrder(null);
      return;
    }
    if (lift === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOrder(null);
      setLift(null);
      setLive(t("projectRunners.cancelled"));
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const to = index + (event.key === "ArrowUp" ? -1 : 1);
      if (to < 0 || to >= count) return;
      setOrder(moveItem(pools, index, to));
      setLive(t("projectRunners.moved", { pool: pool.name, position: to + 1, count }));
      requestAnimationFrame(() => { handles.current.get(pool.poolId)?.focus(); });
    }
  };

  // ---- reorder by drag: pointer events on the handle, the row follows the pointer ----
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, poolId: string) => {
    if (pools.length < 2 || setPools.isPending || lift !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging({ poolId, original: pools });
    setOrder(pools);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragging === null || rowsRef.current === null) return;
    const rows = [...rowsRef.current.querySelectorAll<HTMLElement>("[data-pool-row]")];
    const target = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return event.clientY >= box.top && event.clientY < box.bottom;
    });
    const from = pools.findIndex((pool) => pool.poolId === dragging.poolId);
    if (target >= 0 && from >= 0 && target !== from) setOrder(moveItem(pools, from, target));
  };
  const onPointerUp = () => {
    if (dragging === null) return;
    const changed = pools.some((item, i) => item.poolId !== dragging.original[i]?.poolId);
    setDragging(null);
    if (changed) savePools(pools, t("projectRunners.savedOrder", { pool: pools[0]?.name ?? "" }));
    else setOrder(null);
  };

  // ---- shares ----
  const shareText = (pool: Listed): string => shares[pool.poolId] ?? (pool.maxBoxes === null ? "" : String(pool.maxBoxes));
  const commitShare = (pool: Listed) => {
    const text = shares[pool.poolId];
    if (text === undefined) return;
    const poolMax = useOf(pool.poolId)?.poolMaxBoxes ?? null;
    const parsed = parseShare(text, poolMax);
    if (parsed === "invalid") {
      setShareError({ poolId: pool.poolId, max: poolMax ?? 999 });
      return;
    }
    setShareError(null);
    setShares((current) => withoutKey(current, pool.poolId));
    if (parsed === pool.maxBoxes) return;
    savePools(
      saved.map((item) => (item.poolId === pool.poolId ? { ...item, maxBoxes: parsed } : item)),
      parsed === null ? t("projectRunners.savedNoShare", { project: name, pool: pool.name }) : plural(parsed, "projectRunners.savedShare.one", "projectRunners.savedShare.other", { project: name, pool: pool.name }),
    );
  };

  const others = use.data?.others ?? [];
  const picked = others.find((pool) => pool.poolId === addPick);
  const executorsKnown = pools.some((pool) => (useOf(pool.poolId)?.executors.length ?? 0) > 0);
  const showHostLine = !executorsKnown || pools.some((pool) => useOf(pool.poolId)?.executors.includes("host") === true);
  const loading = runners.data === undefined || use.data === undefined;
  const chosenSize = setSize.isPending ? setSize.variables.size : (runners.data?.defaultBoxSize ?? null);
  const last = lastChangeOf(name, poolsChange.data?.entries[0], sizeChange.data?.entries[0]);
  const poolHref = (poolId: PoolId) => `/organization/runners/pools/${poolId}`;

  const properties = loading || sizes.data === undefined ? (
    <div className="space-y-3" aria-busy>
      <Skeleton className="w-[120px]" />
      <Skeleton className="w-[200px]" />
      <Skeleton className="w-[160px]" />
    </div>
  ) : (
    <>
      <PropGroup title={name}>
        <PropRow label={t("projectRunners.panelPools")} labelWidth={104}><span>{tNodes("projectRunners.panelAllowed", { n: <span className="font-mono">{saved.length}</span> })}</span></PropRow>
        <PropRow label={t("projectRunners.panelRunning")} labelWidth={104}><span data-testid="project-runners-running">{plural(use.data.running, "projectRunners.panelBoxes.one", "projectRunners.panelBoxes.other")}</span></PropRow>
        <PropRow label={t("projectRunners.panelWaiting")} labelWidth={104}>
          {use.data.waiting === 0 ? <span className="text-faint">{t("projectRunners.panelNone")}</span> : plural(use.data.waiting, "projectRunners.panelTasks.one", "projectRunners.panelTasks.other")}
        </PropRow>
        <PropRow label={t("projectRunners.panelDefaultSize")} labelWidth={104}>{runners.data.defaultBoxSize ?? "–"}</PropRow>
      </PropGroup>
      <PropGroup title={t("projectRunners.panelBoxSizes")}>
        {sizes.data.map((size) => (
          <PropRow key={size.name} label={size.name} labelWidth={104}><span className="font-mono">{sizeValue(size.cpuMillis, size.memoryMiB)}</span></PropRow>
        ))}
        {orgAdmin ? (
          <Link href="/organization/box-sizes" className="mt-1.5 inline-flex items-center gap-1 text-sm text-teal hover:underline">
            {t("shell.boxSizes")} <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          </Link>
        ) : null}
      </PropGroup>
      <PropGroup title={t("projectRunners.lastChange")}>
        {last === null ? <p className="text-[12.5px] text-faint">–</p> : (
          <p className="flex items-baseline gap-2 text-[12.5px] text-muted" data-testid="project-runners-last-change">
            <span className="min-w-0 flex-1">{last.line}</span>
            <span className="shrink-0 font-mono text-faint">{formatAge(last.at)}</span>
          </p>
        )}
        <Link href={`/projects/${projectId}/settings/audit?action=project.`} className="mt-1.5 inline-flex items-center gap-1 text-sm text-teal hover:underline">
          {t("projectRunners.auditLog")} <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
        </Link>
      </PropGroup>
    </>
  );

  const removeDialog = (() => {
    if (removing === null) return null;
    const usage = useOf(removing.poolId);
    const running = usage?.held ?? 0;
    const queued = usage?.queued ?? 0;
    const body = [
      t("projectRunners.removeBody", { project: name }),
      running === 0 && queued === 0 ? t("projectRunners.removeNothing", { project: name }) : null,
      running > 0 ? plural(running, "projectRunners.removeRunning.one", "projectRunners.removeRunning.other") : null,
      queued > 0 ? plural(queued, "projectRunners.removeQueued.one", "projectRunners.removeQueued.other") : null,
    ].filter((line) => line !== null).join(" ");
    return (
      <AlertDialogContent
        title={t("projectRunners.removeTitle", { pool: removing.name, project: name })}
        body={body}
        cancel={t("common.cancel")}
        action={t("projectRunners.remove")}
        onAction={() => {
          const pool = removing;
          savePools(saved.filter((item) => item.poolId !== pool.poolId), t("projectRunners.savedRemoved", { pool: pool.name, project: name }));
        }}
      />
    );
  })();

  return (
    <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
      <PageFrame crumbs={[{ label: name, href: `/projects/${projectId}` }, { label: t("projectSettings.settings") }, { label: t("projectRunners.title") }]} properties={properties}>
        <div className="max-w-[760px]">
          <ProjectSettingsTabs projectId={projectId} admin />
          <PageHeading title={t("projectRunners.title")} lede={t("projectRunners.lede", { project: name })} />

          <section className="mt-[26px]">
            <div className="mb-1 flex h-[30px] items-center gap-2">
              <h2 className="text-ui font-semibold">{t("projectRunners.pools")}</h2>
              {loading ? null : <span className="font-mono text-[11.5px] text-faint">{saved.length}</span>}
            </div>
            <div className={cn(grid, "h-[30px] border-b border-line text-[11.5px] font-medium text-faint max-sm:hidden")}>
              <span />
              <span>{t("projectRunners.colPool")}</span>
              <span>{t("projectRunners.colShare")}</span>
              <span>{t("projectRunners.colInUse")}</span>
              <span />
            </div>
            <p aria-live="polite" className="sr-only" data-testid="project-runners-live">{live}</p>
            {loading ? (
              <div aria-busy>{[0, 1, 2].map((i) => <div key={i} className="flex h-11 items-center border-b border-line"><Skeleton className="w-full" /></div>)}</div>
            ) : pools.length === 0 ? (
              <p className="flex h-11 items-center border-b border-line text-ui text-faint">{t("projectRunners.noPools", { project: name })}</p>
            ) : (
              <ul ref={rowsRef} aria-label={t("projectRunners.pools")}>
                {pools.map((pool, index) => {
                  const usage = useOf(pool.poolId);
                  const lifted = (lift !== null && order !== null && lift.original[lift.from]?.poolId === pool.poolId) || dragging?.poolId === pool.poolId;
                  const shareValue = shareText(pool);
                  const invalid = shareError?.poolId === pool.poolId;
                  const savingThis = setPools.isPending && order !== null && lifted;
                  return (
                    <li key={pool.poolId} data-pool-row data-testid="project-pool-row" data-pool={pool.name} className={cn("border-b border-line", lifted && "rounded-md bg-sel")}>
                      <div className={cn(grid, phoneGrid, "min-h-11 text-ui")}>
                        <span className="flex items-center gap-1.5">
                          {savingThis ? (
                            <LoaderCircleIcon aria-hidden className="size-3 text-faint motion-safe:animate-spin" />
                          ) : (
                            <button
                              type="button"
                              ref={(element) => { if (element === null) handles.current.delete(pool.poolId); else handles.current.set(pool.poolId, element); }}
                              aria-label={t("projectRunners.move", { pool: pool.name })}
                              aria-roledescription="sortable"
                              aria-disabled={pools.length < 2}
                              aria-pressed={lifted}
                              className={cn("grid size-6 touch-none place-items-center rounded-md text-faint hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-2", pools.length < 2 ? "cursor-default opacity-50" : "cursor-grab")}
                              onKeyDown={(event) => { onHandleKey(event, index); }}
                              onPointerDown={(event) => { onPointerDown(event, pool.poolId); }}
                              onPointerMove={onPointerMove}
                              onPointerUp={onPointerUp}
                              onPointerCancel={onPointerUp}
                            >
                              <GripVerticalIcon aria-hidden className="size-[15px] stroke-[1.75]" />
                            </button>
                          )}
                          <span className="font-mono text-[12.5px] text-faint">{index + 1}</span>
                        </span>
                        <span className="flex min-w-0 flex-col py-1">
                          <span className="flex min-w-0 items-center gap-2">
                            {orgAdmin ? (
                              <Link href={poolHref(pool.poolId)} className="min-w-0 truncate font-medium text-text hover:underline">{pool.name}</Link>
                            ) : (
                              <span className="min-w-0 truncate font-medium text-text">{pool.name}</span>
                            )}
                            {(usage?.executors ?? []).map((executor) => <ExecutorBadge key={executor} executor={executor} />)}
                          </span>
                          {usage?.needsRegistry === true ? (
                            <span className="text-xs text-muted" data-testid="pool-needs-registry">
                              {t("projectRunners.needsRegistry")}
                              {orgAdmin ? (
                                <Link href="/organization/registry" className="ml-1.5 inline-flex items-center gap-0.5 text-teal">
                                  {t("projectRunners.registryLink")} <ArrowRightIcon aria-hidden className="size-3 stroke-[1.75]" />
                                </Link>
                              ) : null}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-2 max-sm:col-start-2">
                          <input
                            aria-label={t("projectRunners.shareLabel", { project: name, pool: pool.name })}
                            inputMode="numeric"
                            placeholder="–"
                            value={shareValue}
                            aria-invalid={invalid}
                            disabled={setPools.isPending}
                            onChange={(event) => { setShares((current) => ({ ...current, [pool.poolId]: event.target.value })); }}
                            onBlur={() => { commitShare(pool); }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") { event.preventDefault(); commitShare(pool); }
                              if (event.key === "Escape") {
                                setShares((current) => withoutKey(current, pool.poolId));
                                setShareError(null);
                              }
                            }}
                            className={cn("h-7 w-14 rounded-[7px] border border-line-2 bg-surface px-2 font-mono text-ui text-text placeholder:text-faint focus-visible:border-faint focus-visible:outline-none", invalid && "border-red")}
                          />
                          <span className="whitespace-nowrap text-[12.5px] text-faint">
                            {usage?.poolMaxBoxes === null || usage === undefined
                              ? shareValue === "" ? t("projectRunners.noCap") : t("projectRunners.boxes")
                              : t("projectRunners.ofBoxes", { n: usage.poolMaxBoxes })}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 max-sm:col-span-full max-sm:col-start-2">
                          {pool.maxBoxes === null ? (
                            <>
                              <span className="font-mono text-[12.5px] text-text">{usage?.held ?? 0}</span>
                              <span className="text-[12.5px] text-muted">{t("projectRunners.running")}</span>
                            </>
                          ) : (
                            <>
                              <ShareMeter project={name} pool={pool.name} held={usage?.held ?? 0} share={pool.maxBoxes} />
                              <span className="whitespace-nowrap font-mono text-[12.5px] text-text">{usage?.held ?? 0} / {pool.maxBoxes}</span>
                              {(usage?.held ?? 0) >= pool.maxBoxes ? <span className="whitespace-nowrap text-[12.5px] text-muted">{t("projectRunners.atShare")}</span> : null}
                            </>
                          )}
                        </span>
                        <span className="flex justify-end max-sm:col-start-3 max-sm:row-start-2">
                          {saved.length < 2 ? (
                            <Tooltip content={t("projectRunners.removeLastRefused", { pool: pool.name })}>
                              <span><Button variant="ghost" size="sm" className="h-6 text-muted" disabled>{t("projectRunners.remove")}</Button></span>
                            </Tooltip>
                          ) : (
                            <Button variant="ghost" size="sm" className="h-6 text-muted" disabled={setPools.isPending} onClick={() => { setRemoving(pool); }}>{t("projectRunners.remove")}</Button>
                          )}
                        </span>
                      </div>
                      {invalid ? <p className="pb-2 pl-[68px] text-xs text-red" role="alert">{t("projectRunners.invalidShare", { max: shareError.max })}</p> : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {loading ? null : (
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <span className="text-[12.5px] text-muted">{t("projectRunners.addPool")}</span>
                <Select value={addPick} onValueChange={setAddPick} disabled={others.length === 0 || setPools.isPending}>
                  <SelectTrigger aria-label={t("projectRunners.addPool")} className="h-7 w-[240px] bg-surface">
                    <SelectValue placeholder={others.length === 0 ? t("projectRunners.everyPoolListed") : t("projectRunners.pickPool")} />
                  </SelectTrigger>
                  <SelectContent>
                    {others.map((pool) => (
                      <SelectItem key={pool.poolId} value={pool.poolId}>
                        <span className="flex items-center gap-2">{pool.name}{pool.executors.map((executor) => <ExecutorBadge key={executor} executor={executor} />)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  disabled={picked === undefined || setPools.isPending}
                  onClick={() => {
                    if (picked === undefined) return;
                    setAddPick("");
                    savePools([...saved, { poolId: picked.poolId, name: picked.name, isDefault: false, maxBoxes: null }], t("projectRunners.savedAdded", { pool: picked.name, project: name }));
                  }}
                >
                  {t("projectRunners.add")}
                </Button>
              </div>
            )}
            <p className="mt-2 text-xs text-faint">{pools.length < 2 ? t("projectRunners.hintOne", { project: name }) : t("projectRunners.hint", { project: name })}</p>
            {status?.at === "pools" ? (
              <p role="status" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted"><CheckIcon aria-hidden className="size-[13px] stroke-[1.75]" />{status.text}</p>
            ) : null}
            {setPools.error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(setPools.error)}</p>}
          </section>

          <section className="mt-8">
            <h2 className="text-ui font-semibold">{t("projectRunners.defaultSize")}</h2>
            <p className="mb-2 mt-1 text-[12.5px] text-muted">{t("projectRunners.defaultSizeLede", { project: name })}</p>
            <RadioGroup
              aria-label={t("projectRunners.defaultSize")}
              value={chosenSize ?? ""}
              onValueChange={(value) => {
                const size = (sizes.data ?? []).find((item) => item.name === value)?.name;
                if (size === undefined || size === runners.data?.defaultBoxSize) return;
                setStatus(null);
                setSize.mutate({ projectId, size }, { onSuccess: () => { setStatus({ at: "size", text: t("projectRunners.savedSize", { project: name, size }) }); } });
              }}
            >
              {(sizes.data ?? []).map((size) => (
                <label key={size.name} htmlFor={`size-${size.name}`} className={cn("flex h-9 cursor-pointer items-center gap-3 rounded-md border-b border-line px-2.5", chosenSize === size.name && "bg-sel")}>
                  <RadioGroupItem id={`size-${size.name}`} value={size.name satisfies BoxSizeName} disabled={setSize.isPending} className="size-4 data-[state=checked]:border-primary data-[state=checked]:bg-primary [&>span]:bg-on-primary" />
                  <span className="w-[90px] text-ui font-medium text-text">{size.name}</span>
                  {runners.data === undefined ? <Skeleton className="w-[100px]" /> : <span className="font-mono text-[12.5px] text-muted">{sizeValue(size.cpuMillis, size.memoryMiB)}</span>}
                </label>
              ))}
            </RadioGroup>
            {showHostLine ? <p className="mt-2 text-xs text-faint">{tNodes("projectRunners.hostSizes", { host: <span className="font-mono">host</span> })}</p> : null}
            {status?.at === "size" ? (
              <p role="status" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted"><CheckIcon aria-hidden className="size-[13px] stroke-[1.75]" />{status.text}</p>
            ) : null}
            {setSize.error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(setSize.error)}</p>}
          </section>

          <p className="mt-6 flex items-start gap-2 text-[12.5px] text-muted">
            <LaptopIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75] text-faint" />
            {t("projectRunners.personal")}
          </p>
        </div>
      </PageFrame>
      {removeDialog}
    </AlertDialog>
  );
};
