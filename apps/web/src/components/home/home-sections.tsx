"use client";

import {
  CircleXIcon,
  CpuIcon,
  FolderPlusIcon,
  GitPullRequestArrowIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  MessageSquareIcon,
  ServerIcon,
  ShieldCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { PausedRuleRows } from "@/components/automations/paused-rules";
import type { PausedRule } from "@/components/automations/paused-rules";
import { Section } from "@/components/shell/page-frame";
import { BudgetNoticeRows } from "@/components/spend/budget-notices";
import type { BudgetNotice } from "@/components/spend/budget-notices";
import { projectColour } from "@/components/shell/project-colour";
import { buttonVariants } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { actionHref, actionKey, activityIcon, activityParts, amberRow, formatSpend, monthShort, needsYouRowKey, reasonParts } from "./home-words";
import type { ActivityIcon, ActivityRow, NeedsYouRow, Part } from "./home-words";

type Overview = RouterOutputs["home"]["overview"];

/** What a section shows while its data loads, fails or arrives (home.md, Loading and errors). */
export type Load<T> = { readonly kind: "loading" } | { readonly kind: "error"; readonly retry: () => void } | { readonly kind: "ready"; readonly data: T };

const Parts = ({ parts }: { readonly parts: readonly Part[] }) => (
  <>
    {parts.map((part, i) =>
      part.code === true ? (
        <code key={i} className="font-mono text-ui text-text">
          {part.text}
        </code>
      ) : (
        <span key={i}>{part.text}</span>
      ),
    )}
  </>
);

const partsText = (parts: readonly Part[]): string => parts.map((part) => part.text).join("");

/** One row in place of a section's rows: an empty state, or a failure with Retry. */
const OneRow = ({ children }: { readonly children: ReactNode }) => (
  <ul className="rows">
    <li className="flex h-[38px] items-center text-faint">{children}</li>
  </ul>
);

const Failed = ({ retry }: { readonly retry: () => void }) => (
  <OneRow>
    <span role="alert">
      {t("home.loadFailed")}{" "}
      <button type="button" onClick={retry} className="text-teal hover:underline">
        {t("home.retry")}
      </button>
    </span>
  </OneRow>
);

const ProjectSquare = ({ id }: { readonly id: string }) => (
  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(id) }} />
);

// ---------- Needs you ----------

const NeedsYouLine = ({ row, amber, now }: { readonly row: NeedsYouRow; readonly amber: boolean; readonly now: number }) => {
  const reason = reasonParts(row.detail);
  return (
    <li
      className="grid min-h-[38px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-1.5 md:grid-cols-[76px_minmax(0,1fr)_124px_212px_36px_100px] md:py-0"
      data-testid="needs-you-row"
      data-task={row.taskId}
      data-item={needsYouRowKey(row)}
    >
      <div className="col-span-2 flex min-w-0 items-center gap-2 md:contents">
        <span className="shrink-0 font-mono text-sm text-faint">{row.key}</span>
        <Link href={`/tasks/${row.taskId}`} className="min-w-0 truncate text-text hover:underline" title={row.title}>
          {row.title}
        </Link>
      </div>
      <span className="hidden min-w-0 items-center gap-2 text-muted md:flex">
        <ProjectSquare id={row.project.id} />
        <span className="truncate">{row.project.name}</span>
      </span>
      <span className="min-w-0 truncate text-muted" title={partsText(reason)}>
        <Parts parts={reason} />
      </span>
      <span className="hidden text-right font-mono text-sm text-faint md:block" suppressHydrationWarning>
        {formatAge(row.since, now)}
      </span>
      <Link
        href={actionHref(row.detail.reason, row.project.id, row.taskId)}
        className={cn(buttonVariants({ variant: amber ? "amber" : "outline", size: "sm" }), "h-7 w-[100px] justify-self-end text-ui", !amber && "font-normal")}
      >
        {t(actionKey(row.detail.reason))}
      </Link>
    </li>
  );
};

/** Needs you (home.md): first, amber, at most five rows, newest first; never gone, so the page doesn't jump. */
export const NeedsYouSection = ({ load, now, budget, paused = [] }: {
  readonly load: Load<Overview["needsYou"]>;
  readonly now: number;
  /** F-037: the member's budget notices this month, above the task rows. */
  readonly budget?: { readonly notices: readonly BudgetNotice[]; readonly organizationAdmin: boolean };
  /** F-011: the rules their hourly limit paused, in projects the member is an admin of. */
  readonly paused?: readonly PausedRule[];
}) => {
  const notices = budget?.notices ?? [];
  const empty = load.kind === "ready" && load.data.total === 0 && notices.length === 0 && paused.length === 0;
  return (
    <Section title={t("home.needsYou.title")} tone={empty ? "grey" : "amber"} {...(load.kind === "ready" ? { count: load.data.total + notices.length + paused.length } : {})}>
      {load.kind === "loading" ? (
        <SkeletonRows />
      ) : load.kind === "error" ? (
        <Failed retry={load.retry} />
      ) : empty ? (
        <OneRow>{t("home.needsYou.empty")}</OneRow>
      ) : (
        <>
          <BudgetNoticeRows notices={notices} organizationAdmin={budget?.organizationAdmin ?? false} />
          <PausedRuleRows rules={paused} />
          {load.data.rows.length === 0 ? null : (
            <ul className="rows" data-testid="needs-you">
              {load.data.rows.map((row) => (
                <NeedsYouLine key={needsYouRowKey(row)} row={row} amber={needsYouRowKey(row) === amberRow(load.data.rows)} now={now} />
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
};

// ---------- Projects ----------

const Count = ({ n, amber = false }: { readonly n: number; readonly amber?: boolean }) =>
  n === 0 ? <span className="text-faint">–</span> : <span className={amber ? "text-amber-text" : undefined}>{n}</span>;

/** Projects (home.md): a table, sorted by needs you then running, the whole row a link. */
export const ProjectsSection = ({ load, admin, now }: { readonly load: Load<Overview["projects"]>; readonly admin: boolean; readonly now: Date }) => {
  const router = useRouter();
  return (
    <Section title={t("home.projects")} {...(load.kind === "ready" ? { count: load.data.total } : {})}>
      {load.kind === "loading" ? (
        <SkeletonRows />
      ) : load.kind === "error" ? (
        <Failed retry={load.retry} />
      ) : load.data.total === 0 ? (
        <OneRow>{admin ? t("home.noProjectsAdmin") : t("home.noProjects")}</OneRow>
      ) : (
        <Table data-testid="home-projects">
          <TableHeader>
            <TableRow className="border-t">
              <TableHead className="md:w-[160px]">{t("home.table.project")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("home.table.repo")}</TableHead>
              <TableHead num className="w-[72px]">{t("home.table.running")}</TableHead>
              <TableHead num className="hidden w-[76px] md:table-cell">{t("home.table.queued")}</TableHead>
              <TableHead num className="w-[92px]">{t("home.table.needsYou")}</TableHead>
              <TableHead num className="hidden w-[116px] md:table-cell">{t("home.table.prs")}</TableHead>
              <TableHead num className="hidden w-[104px] md:table-cell" suppressHydrationWarning>
                {t("home.table.spend", { month: monthShort(now) })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {load.data.rows.map((project) => (
              <TableRow
                key={project.id}
                className="cursor-pointer hover:bg-hover"
                onClick={() => {
                  router.push(`/projects/${project.id}`);
                }}
              >
                <TableCell>
                  <Link href={`/projects/${project.id}`} className="flex min-w-0 items-center gap-2.5" onClick={(event) => { event.stopPropagation(); }}>
                    <ProjectSquare id={project.id} />
                    <span className="truncate">{project.name}</span>
                  </Link>
                </TableCell>
                <TableCell className="hidden truncate pr-3 font-mono text-ui text-faint md:table-cell" title={project.repos.join(", ")}>
                  {project.repos.join(", ")}
                </TableCell>
                <TableCell num>{project.running}</TableCell>
                <TableCell num className="hidden md:table-cell">{project.queued}</TableCell>
                <TableCell num>
                  <Count n={project.needsYou} amber />
                </TableCell>
                <TableCell num className="hidden md:table-cell">{project.prsThisWeek}</TableCell>
                <TableCell num className="hidden md:table-cell">
                  {project.spendMonth === null ? <span className="text-faint">–</span> : formatSpend(project.spendMonth)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
};

// ---------- Recent activity ----------

const icons: Readonly<Record<ActivityIcon, ReactNode>> = {
  pr: <GitPullRequestArrowIcon className="text-muted" />,
  stopped: <CircleXIcon className="text-red" />,
  runner: <ServerIcon className="text-muted" />,
  project: <FolderPlusIcon className="text-muted" />,
  provider: <CpuIcon className="text-muted" />,
  github: <GitPullRequestIcon className="text-muted" />,
  approval: <ShieldCheckIcon className="text-muted" />,
  plan: <ListChecksIcon className="text-muted" />,
  driver: <UserRoundIcon className="text-muted" />,
  comment: <MessageSquareIcon className="text-muted" />,
};

const ActivityLine = ({ row, now }: { readonly row: ActivityRow; readonly now: number }) => {
  const parts = activityParts(row.event);
  return (
    <li className="flex min-h-[38px] items-center gap-3 [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75]">
      {icons[activityIcon(row.event)]}
      <span className="min-w-0 flex-1 truncate" title={partsText(parts)}>
        <Parts parts={parts} />
      </span>
      <span className="hidden shrink-0 text-muted sm:inline">{row.project === null ? t("home.activity.organization") : row.project.name}</span>
      <span className="w-11 shrink-0 text-right font-mono text-sm text-faint" suppressHydrationWarning>
        {formatAge(row.at, now)}
      </span>
    </li>
  );
};

/** Recent activity (home.md): at most six events, colour only on the icon and always with the words. */
export const ActivitySection = ({ load, now }: { readonly load: Load<Overview["activity"]>; readonly now: number }) => (
  <Section title={t("home.activity.title")}>
    {load.kind === "loading" ? (
      <SkeletonRows />
    ) : load.kind === "error" ? (
      <Failed retry={load.retry} />
    ) : load.data.length === 0 ? (
      <OneRow>{t("home.activity.empty")}</OneRow>
    ) : (
      <ul className="rows" data-testid="home-activity">
        {load.data.map((row) => (
          <ActivityLine key={row.id} row={row} now={now} />
        ))}
      </ul>
    )}
  </Section>
);
