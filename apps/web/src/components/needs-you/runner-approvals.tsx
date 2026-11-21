"use client";

import { ServerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-091 (ticket 31, runner-approval.md): Needs you's Runners band, for organization admins. One row
// per runner waiting for approval; Review selects it and the properties panel holds the approval.
// The rows come from the fleet (`runners.list`'s `awaitingApproval`): a runner notice has no
// needs-you item of its own (ticket 12), and the open approval is the runner's own state.

type Listed = RouterOutputs["runners"]["list"][number];

// The reason column gives the title room at the double sidebar's narrower page (needs-you.md drew 300px beside a 232px sidebar).
const ROW_GRID = "md:grid-cols-[14px_80px_minmax(0,1fr)_260px_44px_112px]";

/** The runners that wait for an admin, oldest first. */
export const awaitingRunners = (runners: readonly Listed[]): readonly Listed[] =>
  runners.filter((runner) => runner.awaitingApproval).toSorted((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0) || a.name.localeCompare(b.name));

export const RunnerApprovalsBand = ({ runners, selected, onSelect, now }: {
  readonly runners: readonly Listed[];
  readonly selected: string | null;
  readonly onSelect: (runnerId: string) => void;
  readonly now: number;
}) => (
  <section data-group="runners">
    <div className="flex h-[30px] items-center gap-2 rounded-sm bg-surface px-2.5">
      <ServerIcon aria-hidden className="size-[15px] stroke-[1.75] text-muted" />
      <span className="text-sm font-semibold text-text">{t("needsYouPage.runner.group")}</span>
      <span className="font-mono text-xs text-faint">{runners.length}</span>
    </div>
    <ul>
      {runners.map((runner) => (
        <li key={runner.id} className="border-b border-line" data-runner-approval={runner.name} aria-selected={selected === runner.id}>
          <div className={cn("grid min-h-10 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 py-1.5 md:py-0", ROW_GRID, selected === runner.id ? "bg-sel" : "hover:bg-hover")}>
            <span className="flex justify-center"><span role="img" aria-label={t("needsYouPage.unread")} className="size-1.5 rounded-full bg-text" /></span>
            <div className="flex min-w-0 items-center gap-2 md:contents">
              <span className="shrink-0 truncate font-mono text-xs text-faint">{runner.name}</span>
              <span className="min-w-0 truncate text-ui font-medium text-text">{t("needsYouPage.runner.wantsToJoin", { name: runner.name, pool: runner.pool?.name ?? "—" })}</span>
            </div>
            <span className="col-start-2 min-w-0 truncate text-sm text-muted md:col-start-auto">{t("needsYouPage.runner.reasonApproval")}</span>
            <span className="hidden text-right font-mono text-xs text-faint md:block" suppressHydrationWarning>{runner.lastSeenAt === null ? "" : formatAge(runner.lastSeenAt, now)}</span>
            <span className="col-start-3 row-span-2 row-start-1 flex items-center md:col-start-auto md:row-span-1 md:row-start-auto md:justify-end">
              <Button size="sm" className="h-[26px] w-[112px] font-normal" aria-pressed={selected === runner.id} onClick={() => { onSelect(runner.id); }}>
                {t("needsYouPage.runner.review")}
              </Button>
            </span>
          </div>
        </li>
      ))}
    </ul>
  </section>
);
