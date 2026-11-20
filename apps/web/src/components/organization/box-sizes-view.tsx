"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { BoxSizeName } from "@ostra/protocol";

import { PageFrame, PageHeading, PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { tNodes } from "@/lib/message-nodes";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { behindLead, behindTail, cpuText, gibText, invalidLines, lastChangeLine, parseCpu, parseMemory, roomWarning, slotsOnlyLine } from "./box-sizes-words";
import type { Bounds, Limits } from "./box-sizes-words";

type Size = RouterOutputs["boxSizes"]["list"][number];
type Use = RouterOutputs["fleetUse"]["boxSizes"];
type Draft = Readonly<Partial<Record<BoxSizeName, { readonly cpu: string; readonly memory: string }>>>;

const grid = "grid items-center gap-x-3 grid-cols-[90px_86px_150px_minmax(0,1fr)_160px]";
const phoneGrid = "max-md:grid-cols-[1fr_1fr] max-md:gap-y-2 max-md:py-3";

/** The single-series bar of Boxes now (dataviz: one colour, the count beside it as its label). */
const BoxesBar = ({ name, count, max }: { readonly name: BoxSizeName; readonly count: number; readonly max: number }) => (
  <span className="flex items-center justify-end gap-2">
    <span role="img" aria-label={t("boxSizes.barLabel", { n: count, size: name })} className="relative block h-1.5 w-[120px] overflow-hidden rounded-[3px] bg-line">
      <span className="absolute inset-y-0 left-0 rounded-[3px] bg-[var(--chart)]" style={{ width: `${String(max === 0 ? 0 : (count / max) * 100)}%` }} />
    </span>
    <span className="w-7 text-right font-mono text-ui text-text">{count}</span>
  </span>
);

/** Default for: the first two projects by name, each a link to its Runners tab, then `+13`. */
const DefaultFor = ({ projects }: { readonly projects: Use["sizes"][number]["projects"] }) => {
  if (projects.length === 0) return <span className="text-sm text-faint">{t("boxSizes.noProject")}</span>;
  const shown = projects.slice(0, 2);
  const rest = projects.length - shown.length;
  return (
    <span className="min-w-0 truncate text-sm text-muted">
      {shown.map((project, i) => (
        <span key={project.id}>
          {i > 0 ? ", " : null}
          <Link href={`/projects/${project.id}/settings/runners`} className="hover:text-text">{project.name}</Link>
        </span>
      ))}
      {rest > 0 ? (
        <>
          {", "}
          <Tooltip content={projects.map((project) => project.name).join(", ")}>
            <button type="button" className="text-muted hover:text-text">{t("boxSizes.more", { n: rest })}</button>
          </Tooltip>
        </>
      ) : null}
    </span>
  );
};

/** The value a size shows: the admin's typed text, else the saved value. */
const draftOf = (size: Size, draft: Draft) => draft[size.name] ?? { cpu: cpuText(size.cpuMillis), memory: gibText(size.memoryMiB) };

/**
 * Organization › Box sizes (F-095, box-sizes.md): the three sizes, editable by organization admins,
 * where each is a project's default, how many boxes of each run now, and where a size is a limit.
 * Members read it.
 */
export const BoxSizesView = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const sizes = useQuery(trpc.boxSizes.list.queryOptions());
  const use = useQuery(trpc.fleetUse.boxSizes.queryOptions());
  const admin = me.data?.organization?.role === "admin";
  const lastChange = useQuery({ ...trpc.audit.list.queryOptions({ action: "box-size.", limit: 1 }), enabled: admin });
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState(false);
  const update = useMutation(trpc.boxSizes.update.mutationOptions());
  const [saving, setSaving] = useState(false);

  const bounds: Bounds | undefined = use.data?.bounds;
  const rows = (sizes.data ?? []).map((size) => {
    const shown = draftOf(size, draft);
    const cpu = bounds === undefined ? null : parseCpu(shown.cpu, bounds);
    const memory = bounds === undefined ? null : parseMemory(shown.memory, bounds);
    const cpuChanged = shown.cpu.trim() !== cpuText(size.cpuMillis);
    const memoryChanged = shown.memory.trim() !== gibText(size.memoryMiB);
    return { size, shown, cpu, memory, cpuChanged, memoryChanged, changed: (cpuChanged && cpu !== size.cpuMillis) || (memoryChanged && memory !== size.memoryMiB) };
  });
  const invalid = bounds === undefined ? [] : rows.flatMap((row) => invalidLines(row.size.name, row.cpu, row.memory, bounds));
  const changed = rows.filter((row) => row.changed);
  const canSave = admin && changed.length > 0 && invalid.length === 0 && !saving;
  const largestMax = Math.max(0, ...(use.data?.sizes.map((size) => size.boxesNow) ?? []));
  const warnings =
    !admin || use.data === undefined || use.data.runners.enforce === 0
      ? []
      : rows.flatMap((row) => {
          const limits: Limits = { cpuMillis: row.cpu ?? row.size.cpuMillis, memoryMiB: row.memory ?? row.size.memoryMiB };
          const projects = use.data.sizes.find((size) => size.name === row.size.name)?.projects.length ?? 0;
          const line = roomWarning(row.size.name, limits, use.data.largest, projects);
          return line === null ? [] : [{ name: row.size.name, line }];
        });

  const save = async () => {
    setSaving(true);
    update.reset();
    setSaved(false);
    try {
      for (const row of changed) {
        if (row.cpu === null || row.memory === null) return;
        await update.mutateAsync({ name: row.size.name, cpuMillis: row.cpu, memoryMiB: row.memory });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.boxSizes.list.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.fleetUse.boxSizes.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.audit.list.pathKey() }),
      ]);
      setDraft({});
      setSaved(true);
    } catch {
      // `update.error` holds it, shown under the table; the typed values stay.
    } finally {
      setSaving(false);
    }
  };

  const setValue = (name: BoxSizeName, size: Size, field: "cpu" | "memory", value: string) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [name]: { ...draftOf(size, current), [field]: value } }));
  };

  const loading = sizes.data === undefined || use.data === undefined || me.data === undefined;
  const runners = use.data?.runners;

  const properties = loading ? (
    <div className="space-y-3" aria-busy>
      <Skeleton className="w-[140px]" />
      <Skeleton className="w-[220px]" />
      <Skeleton className="w-[180px]" />
    </div>
  ) : (
    <>
      <PropGroup title={t("boxSizes.whereApply")}>
        <PropRow label="docker" labelWidth={130} labelClassName="font-mono">{t("boxSizes.docker")}</PropRow>
        <PropRow label="kubernetes" labelWidth={130} labelClassName="font-mono">{t("boxSizes.kubernetes")}</PropRow>
        <PropRow label="host" labelWidth={130} labelClassName="font-mono"><span className="text-faint">{t("boxSizes.host")}</span></PropRow>
      </PropGroup>
      <PropGroup title={t("boxSizes.runners")}>
        <PropRow label={t("boxSizes.enforce")} labelWidth={130}><span className="font-mono" data-testid="box-sizes-enforce">{runners?.enforce ?? 0}</span></PropRow>
        <PropRow label={t("boxSizes.slotsOnly")} labelWidth={130}><span className="font-mono">{runners?.slotsOnly ?? 0}</span></PropRow>
        {runners === undefined ? null : (
          <p className="mt-1.5 text-[12.5px] text-muted">
            {runners.behind.length === 0 || runners.enforce === 0 ? (
              slotsOnlyLine(runners)
            ) : (
              <>
                {behindLead(runners.host)}
                {runners.behind.map((runner, i) => (
                  <span key={runner.id}>
                    {i > 0 ? ", " : null}
                    <Link href={`/organization/runners/${runner.id}`} className="text-teal hover:underline">{runner.name}</Link>
                  </span>
                ))}
                {behindTail(runners.behind.length)}
              </>
            )}
          </p>
        )}
      </PropGroup>
      <PropGroup title={t("boxSizes.bounds")}>
        <PropRow label={t("boxSizes.smallest")} labelWidth={130}>
          <span className="font-mono">{bounds === undefined ? null : t("boxSizes.boundValue", { cpu: cpuText(bounds.min.cpuMillis), memory: gibText(bounds.min.memoryMiB) })}</span>
        </PropRow>
      </PropGroup>
      {admin ? (
        <PropGroup title={t("boxSizes.lastChange")}>
          <p className="text-ui text-muted" data-testid="box-sizes-last-change">{lastChange.data === undefined ? <Skeleton className="w-[200px]" /> : lastChangeLine(lastChange.data.entries[0])}</p>
          <Link href="/organization/audit?action=box-size." className="mt-1.5 inline-flex items-center gap-1 text-sm text-teal hover:underline">
            {t("boxSizes.auditLog")} <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
          </Link>
        </PropGroup>
      ) : null}
    </>
  );

  const input = (row: (typeof rows)[number], field: "cpu" | "memory") => {
    const value = field === "cpu" ? row.shown.cpu : row.shown.memory;
    const bad = field === "cpu" ? row.cpu === null : row.memory === null;
    const edited = field === "cpu" ? row.cpuChanged : row.memoryChanged;
    return (
      <input
        aria-label={t(field === "cpu" ? "boxSizes.cpuLabel" : "boxSizes.memoryLabel", { size: row.size.name })}
        inputMode="decimal"
        value={value}
        aria-invalid={bad}
        disabled={saving}
        onChange={(event) => { setValue(row.size.name, row.size, field, event.target.value); }}
        className={cn(
          "h-[34px] w-[56px] rounded-[7px] border border-control-line bg-surface px-2.5 font-mono text-[14px] text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-muted",
          edited && "border-muted",
          bad && "border-red",
        )}
      />
    );
  };

  return (
    <PageFrame
      crumbs={[{ label: me.data?.organization?.name ?? t("shell.organization") }, { label: t("boxSizes.title") }]}
      actions={
        admin ? (
          <Button variant="primary" disabled={!canSave} onClick={() => { void save(); }} data-action="save-sizes">
            {saving ? t("boxSizes.saving") : t("boxSizes.save")}
          </Button>
        ) : undefined
      }
      properties={properties}
    >
      <div className="max-w-[760px]">
        <PageHeading title={t("boxSizes.title")} lede={t("boxSizes.lede")} />
        {me.data !== undefined && !admin ? <p className="text-xs text-faint">{t("boxSizes.readOnly")}</p> : null}

        <section className="mt-7">
          <div className="mb-1 flex h-[30px] items-center gap-2">
            <h2 className="text-body font-semibold">{t("boxSizes.sizes")}</h2>
            <span className="font-mono text-[12.5px] text-faint">3</span>
          </div>
          <div className={cn(grid, "h-[30px] border-b border-line text-xs font-medium text-faint max-md:hidden")}>
            <span>{t("boxSizes.colSize")}</span>
            <span>{t("boxSizes.colCpu")}</span>
            <span>{t("boxSizes.colMemory")}</span>
            <span>{t("boxSizes.colDefaultFor")}</span>
            <span>{t("boxSizes.colBoxesNow")}</span>
          </div>
          {loading ? (
            <div aria-busy>
              {[0, 1, 2].map((i) => <div key={i} className="flex h-12 items-center border-b border-line"><Skeleton className="w-full" /></div>)}
            </div>
          ) : (
            <ul aria-label={t("boxSizes.sizes")}>
              {rows.map((row) => {
                const usage = use.data.sizes.find((size) => size.name === row.size.name);
                return (
                  <li key={row.size.name} data-testid="box-size-row" data-size={row.size.name} className={cn(grid, phoneGrid, "min-h-12 border-b border-line text-ui")}>
                    <span className="font-mono text-text max-md:col-span-2">{row.size.name}</span>
                    {admin ? (
                      <>
                        <span className="flex items-center gap-2">{input(row, "cpu")}<span className="text-faint md:hidden">{t("boxSizes.colCpu")}</span></span>
                        <span className="flex items-center gap-2">
                          {input(row, "memory")}
                          <span className="text-faint">{t("boxSizes.gib")}</span>
                          {row.memoryChanged ? <span className="font-mono text-xs text-faint">{t("boxSizes.was", { value: gibText(row.size.memoryMiB) })}</span> : null}
                          {row.cpuChanged && !row.memoryChanged ? <span className="font-mono text-xs text-faint">{t("boxSizes.was", { value: cpuText(row.size.cpuMillis) })}</span> : null}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-text">{cpuText(row.size.cpuMillis)}<span className="ml-2 font-sans text-faint md:hidden">{t("boxSizes.colCpu")}</span></span>
                        <span className="font-mono text-text">{gibText(row.size.memoryMiB)} <span className="font-sans text-faint">{t("boxSizes.gib")}</span></span>
                      </>
                    )}
                    <DefaultFor projects={usage?.projects ?? []} />
                    <BoxesBar name={row.size.name} count={usage?.boxesNow ?? 0} max={largestMax} />
                  </li>
                );
              })}
            </ul>
          )}
          {invalid.length === 0 ? null : (
            <div role="alert" className="mt-2 space-y-0.5 text-[12.5px] text-red">
              {invalid.map((line) => <p key={line}>{line}</p>)}
            </div>
          )}
          {update.error === null ? null : <p role="alert" className="mt-2 text-[12.5px] text-red">{errorText(update.error)}</p>}
          {warnings.map((warning) => (
            <p key={warning.name} className="mt-3 flex items-start gap-2 text-sm text-muted" data-testid="box-sizes-warning">
              <CircleAlertIcon aria-hidden className="mt-[2px] size-[15px] shrink-0 stroke-[1.75]" />
              <span>{warning.line}</span>
            </p>
          ))}
          <p className="mt-6 border-l-2 border-line-2 pl-3 text-sm text-muted" data-testid="box-sizes-host-note">
            {tNodes("boxSizes.hostNote", { host: <span className="font-mono">host</span> })}
          </p>
          <p className="mt-4 text-[12.5px] text-faint">{t("boxSizes.footnote")}</p>
          {saved ? (
            <p role="status" className="mt-2 flex items-center gap-1.5 text-[12.5px] text-green">
              <CheckIcon aria-hidden className="size-[13px] stroke-[1.75]" />
              {t("boxSizes.saved")}
            </p>
          ) : null}
        </section>
      </div>
    </PageFrame>
  );
};
