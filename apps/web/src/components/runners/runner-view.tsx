"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";

import { PROTOCOL_MINOR } from "@ostra/protocol";

import { PageFrame, pageTitleGap, PropGroup, PropRow, Section } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Skeleton } from "@/components/ui/skeleton";
import { Chip } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { containmentNote, containmentText } from "./fleet-words";
import { RunnerButtons } from "./runner-actions";
import type { ActionRunner } from "./runner-actions";
import { Fingerprint, RunnerApproval } from "./runner-approval";
import {
  boxSizeText,
  boxTaskKey,
  builtInLabels,
  carrierRow,
  connectionText,
  consequenceLine,
  executorNote,
  gibText,
  historyText,
  installText,
  joinedAt,
  ownLabels,
  pageVersionChip,
  protocolText,
  runnerLede,
  systemText,
  vcpuText,
  versionFix,
} from "./runner-page-words";
import { RunnerStatus } from "./runner-rows";
import { shortDate } from "./runner-words";

// F-092, F-061, F-013, F-014, F-091 (ticket 31, runner.md): one runner's page. An admin sees any
// runner of the organization; a member only their own personal runner (Revoke, no Drain), and any
// other is not found. Polls `runners.get` every 5 s: state, carrier and boxes change in place.

type Page = RouterOutputs["runners"]["get"];

const LIVE_MS = 5_000;
const KEY = 160;

/** A status row: key, value, and a secondary half 12px after it. */
const StatusRow = ({ label, children, note, testId }: { readonly label: string; readonly children: ReactNode; readonly note?: ReactNode; readonly testId?: string }) => (
  <div className="flex min-h-[34px] flex-wrap items-center gap-x-3 border-b border-line py-1.5 text-ui sm:flex-nowrap" data-testid={testId}>
    <span className="shrink-0 text-muted" style={{ width: KEY }}>{label}</span>
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-text">
      {children}
      {note === undefined || note === null ? null : <span className="text-[13px] text-muted">{note}</span>}
    </span>
  </div>
);

/** A capacity bar: 220 × 6px, Mist on `--line`; never red or amber, a full runner is working. */
const Bar = ({ value, max, label }: { readonly value: number; readonly max: number; readonly label: string }) => (
  <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="relative inline-block h-1.5 w-[220px] max-w-full shrink overflow-hidden rounded-[3px] bg-line">
    <span className="absolute inset-y-0 left-0 rounded-[3px] bg-meter" style={{ width: `${String(max === 0 ? 0 : Math.min(100, (value / max) * 100))}%` }} />
  </span>
);

/** A Capacity row: key, the bar, and `{used} of {offered}` in mono. */
const CapacityRow = ({ label, used, offered, text, testId }: { readonly label: string; readonly used: number; readonly offered: number; readonly text: string; readonly testId: string }) => (
  <div className="flex min-h-[30px] items-center gap-3 text-ui" data-testid={testId}>
    <span className="shrink-0 text-muted" style={{ width: KEY }}>{label}</span>
    <Bar value={used} max={offered} label={label} />
    <span className="font-mono text-text">{text}</span>
  </div>
);

/**
 * Capacity (runner.md): slots busy, and where sizes apply the CPU and memory the slot-holding
 * boxes take (`runnerRoom`) against what the runner offers.
 */
export const Capacity = ({ page }: { readonly page: Pick<Page, "busy" | "slots" | "resources" | "used" | "executor"> }) => (
  <Section title={t("runner.page.capacity")}>
    <CapacityRow label={t("runner.page.slots")} used={page.busy} offered={page.slots} text={t("runner.page.slotsBusy", { busy: page.busy, slots: page.slots })} testId="capacity-slots" />
    {page.resources === null || page.used === null ? null : (
      <>
        <CapacityRow
          label={t("runner.page.cpu")}
          used={page.used.cpuMillis}
          offered={page.resources.cpuMillis}
          text={t("runner.page.cpuUse", { used: vcpuText(page.used.cpuMillis), offered: vcpuText(page.resources.cpuMillis) })}
          testId="capacity-cpu"
        />
        <CapacityRow
          label={t("runner.page.memory")}
          used={page.used.memoryMiB}
          offered={page.resources.memoryMiB}
          text={t("runner.page.memoryUse", { used: gibText(page.used.memoryMiB), offered: gibText(page.resources.memoryMiB) })}
          testId="capacity-memory"
        />
      </>
    )}
    <p className="mt-1 text-[12.5px] text-faint">
      {page.executor === "host"
        ? t("runner.page.hostSlotsOnly")
        : page.resources === null
          ? t("runner.page.sizesNotEnforced")
          : page.executor === "kubernetes"
            ? t("runner.page.offerKubernetes")
            : t("runner.page.offerDocker")}
    </p>
  </Section>
);

/** Boxes (runner.md): each slot-holding box's task by key and title, its project, size and age. */
export const Boxes = ({ page, now }: { readonly page: Pick<Page, "boxes" | "executor" | "resources" | "state">; readonly now: number }) => (
  <Section title={t("runner.page.boxes")} count={page.boxes.length}>
    <div className="overflow-x-auto" role="region" aria-label={t("runner.page.boxes")} tabIndex={0}>
      <table className="w-full min-w-[560px] border-collapse text-ui">
        <thead>
          <tr className="border-b border-line">
            <th className="h-[30px] pr-3 text-left text-xs font-medium text-faint">{t("runner.page.colTask")}</th>
            <th className="h-[30px] w-[160px] pr-3 text-left text-xs font-medium text-faint">{t("runners.pool.col.project")}</th>
            <th className="h-[30px] w-[200px] pr-3 text-left text-xs font-medium text-faint">{t("runner.page.colSize")}</th>
            <th className="h-[30px] w-[72px] text-right text-xs font-medium text-faint">{t("runner.page.colRunning")}</th>
          </tr>
        </thead>
        <tbody>
          {page.boxes.length === 0 ? (
            <tr className="h-10 border-b border-line">
              <td colSpan={4} className="text-muted">{page.state === "draining" ? t("runner.page.noBoxDrained") : t("runner.page.noBox")}</td>
            </tr>
          ) : null}
          {page.boxes.map((box) => (
            <tr key={box.id} className="h-10 border-b border-line" data-box={box.task.title}>
              <td className="max-w-0 pr-3">
                <Link href={`/tasks/${box.task.id}`} className="flex min-w-0 items-center gap-3 hover:underline">
                  <span className="shrink-0 font-mono text-faint">{boxTaskKey(box.task)}</span>
                  <span className="truncate text-text">{box.task.title}</span>
                </Link>
              </td>
              <td className="pr-3">
                <span className="flex items-center gap-2.5 text-muted">
                  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(box.task.project.id) }} />
                  <span className="truncate">{box.task.project.name}</span>
                </span>
              </td>
              <td className="whitespace-nowrap pr-3 font-mono text-text">
                {boxSizeText(box, page.executor)}
                {page.resources === null && page.executor !== "host" ? <span className="text-faint">{t("runner.page.notEnforced")}</span> : null}
              </td>
              <td className="text-right font-mono text-text">
                {box.waitingReason === null ? formatAge(box.createdAt, now).replace("now", "0m") : <span className="font-sans text-muted">{t("runner.page.waitingNode", { age: formatAge(box.createdAt, now) })}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Section>
);

const History = ({ page }: { readonly page: Page }) => (
  <Section title={t("runner.page.history")}>
    <ul data-testid="runner-history">
      {page.audit.map((entry) => (
        <li key={entry.id} className="flex h-[26px] items-center text-[12.5px]">
          <span className="w-[120px] shrink-0 font-mono text-faint">{joinedAt(entry.at)}</span>
          <span className="truncate text-muted">{historyText(entry.action, entry.actorName, page.pool?.name ?? null)}</span>
        </li>
      ))}
    </ul>
    <Link href={`/organization/audit?entity=runner&entityId=${page.id}`} className="mt-1.5 inline-block text-[12.5px] text-teal hover:underline">{t("runner.page.auditLog")}</Link>
  </Section>
);

const Panel = ({ page, admin, own, now }: { readonly page: Page | undefined; readonly admin: boolean; readonly own: boolean; readonly now: number }) => {
  const v = (node: (page: Page) => ReactNode) => (page === undefined ? <Skeleton className="w-24" /> : node(page));
  const consequence = page === undefined ? null : consequenceLine(page.state, page.busy, own);
  return (
    <div data-testid="runner-panel">
      <PropGroup title={t("runner.page.panelRunner")}>
        <PropRow label={t("runner.page.pool")} labelWidth={110}>
          {v((p) =>
            p.pool !== null ? (
              admin ? <Link href={`/organization/runners/pools/${p.pool.id}`} className="font-mono hover:underline">{p.pool.name}</Link> : <span className="font-mono">{p.pool.name}</span>
            ) : (
              <span>{t("runner.page.personalOf", { name: p.owner?.name ?? t("common.unknown") })}</span>
            ),
          )}
        </PropRow>
        <PropRow label={t("runner.page.host")} labelWidth={110}>{v((p) => <span className="truncate font-mono">{p.name}</span>)}</PropRow>
        <PropRow label={t("runner.page.system")} labelWidth={110}>{v((p) => <span className="font-mono">{systemText(p.os)}</span>)}</PropRow>
        <PropRow label={t("runner.page.lastSeen")} labelWidth={110}>
          {v((p) => (p.connection !== null ? t("runner.page.now") : p.lastSeenAt === null ? t("runner.page.never") : t("runner.page.ago", { age: formatAge(p.lastSeenAt, now) })))}
        </PropRow>
      </PropGroup>
      <PropGroup title={t("runners.col.labels")}>
        {v((p) => {
          const own = ownLabels(p.labels);
          return (
            <div className="flex flex-wrap gap-1.5" data-testid="runner-labels">
              {own.length === 0 ? <span className="mr-1 text-faint">{t("runner.page.none")}</span> : own.map((label) => <Chip key={label} className="font-mono text-[12px] text-text">{label}</Chip>)}
              {builtInLabels(p.executor, p.os).map((label) => <Chip key={label} className="font-mono text-[12px] text-faint">{label}</Chip>)}
            </div>
          );
        })}
      </PropGroup>
      <PropGroup title={t("runner.page.joinedGroup")}>
        <PropRow label={t("runner.page.token")} labelWidth={110}>
          {v((p) =>
            p.kind === "personal" ? (
              t("runner.page.deviceCode")
            ) : p.joinToken === null ? (
              <span className="text-faint">—</span>
            ) : (
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={cn("truncate font-mono", p.joinToken.revoked && "text-faint line-through")}>{p.joinToken.label ?? t("runners.joinToken")}</span>
                {p.joinToken.revoked ? <span className="text-sm text-faint">{t("runner.page.tokenRevoked")}</span> : null}
              </span>
            ),
          )}
        </PropRow>
        <PropRow label={t("runner.page.joined")} labelWidth={110}>{v((p) => <span className="font-mono">{joinedAt(p.createdAt)}</span>)}</PropRow>
        <PropRow label={t("runner.page.approvedBy")} labelWidth={110}>
          {v((p) =>
            p.kind === "personal" ? (
              <span className="text-faint">{t("runner.page.notRequired")}</span>
            ) : p.awaitingApproval ? (
              <span className="text-faint">{t("runner.page.waiting")}</span>
            ) : p.approvedBy === null ? (
              <span className="text-faint">{t("runner.page.notRequired")}</span>
            ) : (
              <span>{`${p.approvedBy.name ?? t("common.unknown")} · ${p.approvedAt === null ? "" : shortDate(p.approvedAt)}`}</span>
            ),
          )}
        </PropRow>
        <PropRow label={t("runner.page.key")} labelWidth={110}>{v((p) => <Fingerprint value={p.keyFingerprint} />)}</PropRow>
      </PropGroup>
      {consequence === null ? null : <p className="text-[12.5px] text-faint" data-testid="runner-consequence">{consequence}</p>}
    </div>
  );
};

export const RunnerView = ({ runnerId, admin, serverVersion }: { readonly runnerId: string; readonly admin: boolean; readonly serverVersion: string }) => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const query = useQuery({ ...trpc.runners.get.queryOptions({ runnerId }), refetchInterval: LIVE_MS, retry: (count, error) => error.data?.code !== "NOT_FOUND" && count < 2 });
  const page = query.data;
  const now = Date.now();
  const organization = me.data?.organization?.name ?? t("shell.organization");
  const own = page?.kind === "personal" && me.data !== undefined && page.owner?.memberId === me.data.memberId;
  const middle = page === undefined ? [] : page.kind === "personal" ? [{ label: own ? t("runners.yourMachine") : t("runners.personal"), href: "/organization/runners" }] : page.pool === null ? [] : [{ label: page.pool.name, ...(admin ? { href: `/organization/runners/pools/${page.pool.id}` } : {}) }];
  const crumbs = [{ label: organization }, { label: t("shell.runners"), href: "/organization/runners" }, ...middle, { label: page?.name ?? "…" }];

  if (query.error?.data?.code === "NOT_FOUND") {
    return (
      <PageFrame crumbs={crumbs.slice(0, 2)}>
        <h1 className="page-title">{t("runner.page.notFoundTitle")}</h1>
        <p className="mt-1.5 text-lede text-muted">{t("runner.page.notFound")}</p>
      </PageFrame>
    );
  }

  const actionRunner: ActionRunner | null =
    page === undefined ? null : { id: page.id, name: page.name, kind: page.kind, state: page.state, busy: page.busy, minor: page.minor, awaitingApproval: page.awaitingApproval, poolName: page.pool?.name ?? null };
  const chip = page === undefined ? null : pageVersionChip(page.versionState);
  const fix = page === undefined ? null : versionFix(page.versionState, page.install, serverVersion, page.minor, PROTOCOL_MINOR);
  const carrier = page === undefined ? null : carrierRow(page);
  const connection = page === undefined ? null : connectionText(page, now);
  const install = page === undefined ? null : installText(page.install);
  const joining = page?.state === "joining";
  const revoked = page?.state === "revoked";
  const sk = <Skeleton className="w-40" />;

  return (
    <PageFrame
      crumbs={crumbs}
      actions={actionRunner === null || joining ? null : <RunnerButtons runner={actionRunner} admin={admin && !own} own={own} />}
      properties={<Panel page={page} admin={admin} own={own} now={now} />}
    >
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", pageTitleGap(false))}>
        <h1 className="page-title break-all">{page?.name ?? ""}</h1>
        {page === undefined ? null : (
          <span data-testid="runner-state">
            <RunnerStatus state={page.state} {...(page.awaitingApproval ? { text: t("runners.pool.waitingApproval") } : {})} />
          </span>
        )}
      </div>
      {page === undefined ? <Skeleton className="mt-2 h-4 w-[360px] max-w-full" /> : <p className="text-lede text-muted" data-testid="runner-lede">{runnerLede(page)}</p>}

      {admin && page?.awaitingApproval === true ? (
        <div className="mt-6 max-w-[520px]">
          <RunnerApproval runnerId={runnerId} organization={organization} page={page} now={now} />
        </div>
      ) : null}

      <div className="mt-6">
        <StatusRow label={t("runner.page.connection")} testId="row-connection">
          {connection === null ? sk : (
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className={cn("inline-block size-[9px] rounded-full", connection.on ? "bg-green" : "bg-faint")} />
              {connection.text}
            </span>
          )}
        </StatusRow>
        <StatusRow label={t("runner.page.carrier")} note={carrier?.note} testId="row-carrier">
          {carrier === null ? sk : <span className={cn("font-mono", carrier.faint && "text-faint")}>{carrier.carrier}</span>}
        </StatusRow>
        <div className="border-b border-line py-1.5 text-ui" data-testid="row-version">
          <div className="flex min-h-6 flex-wrap items-center gap-x-3">
            <span className="shrink-0 text-muted" style={{ width: KEY }}>{t("runners.col.version")}</span>
            {page === undefined ? sk : (
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-text">v{page.version}</span>
                {chip === null ? null : <Chip className={cn("text-[12px]", chip.red && "border-red text-red")}>{chip.text}</Chip>}
                <span className="font-mono text-[13px] text-faint">{`${t("runner.version.server", { version: serverVersion })} · ${protocolText(page.minor, PROTOCOL_MINOR)}`}</span>
              </span>
            )}
          </div>
          {fix === null ? null : (
            <div className="mt-1.5 max-w-[620px] border-l-2 border-line-2 pl-3 text-sm text-muted sm:ml-[172px]" data-testid="version-fix">
              {fix}{" "}
              <a href="https://github.com/JoeyKhd/ostra/blob/main/docs/configuration.md#the-runner" className="text-teal hover:underline">{t("runner.version.howTo")}</a>
            </div>
          )}
        </div>
        <StatusRow
          label={t("runners.col.executor")}
          note={page === undefined ? null : executorNote(page.lines).filter((note) => !note.chip).map((note) => note.text).join(" ")}
        >
          {page === undefined ? sk : (
            <>
              <span className="font-mono">{page.executor}</span>
              {executorNote(page.lines).filter((note) => note.chip).map((note) => <Chip key={note.text}>{note.text}</Chip>)}
            </>
          )}
        </StatusRow>
        <StatusRow label={t("runner.page.containment")} note={page === undefined ? null : containmentNote(page.processContainment)}>
          {page === undefined ? sk : page.processContainment === null ? <span className="text-faint">{t("runner.page.notReported")}</span> : containmentText(page.processContainment)}
        </StatusRow>
        <StatusRow label={t("runner.page.install")} note={install?.note}>
          {install === null ? sk : install.word}
        </StatusRow>
      </div>

      {page === undefined ? (
        <div className="mt-7 space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[30px] w-full" />)}</div>
      ) : joining ? null : (
        <>
          {revoked ? null : <Capacity page={page} />}
          <Boxes page={page} now={now} />
        </>
      )}
      {page === undefined || page.audit.length === 0 ? null : <History page={page} />}
    </PageFrame>
  );
};
