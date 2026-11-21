"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, GitPullRequestIcon, HistoryIcon } from "lucide-react";
import Link from "next/link";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import type { PanelMode } from "../context-panel";
import { PanelFrame, PanelTitle } from "../context-panel";
import { LiveFailed, LiveSkeleton, LiveTaskRow } from "../live-task-row";
import { yoursLive } from "../live-tasks";
import { NavLink, SectionLabel } from "../nav-link";
import { homeRows } from "../places";
import { ShellIconView } from "../shell-icons";
import { useShellState } from "../shell-state";

/** How many of the member's live tasks show before `{n} more`. */
const YOURS_SHOWN = 6;

/** A recent task's mark, from its state where the board knows it: done, in review or failed. */
const RecentMark = ({ state }: { readonly state: string | null }) => {
  if (state === "done" || state === "merged") return <CircleCheckIcon aria-hidden />;
  if (state === "in_review") return <GitPullRequestIcon aria-hidden />;
  if (state === "stopped") return <CircleXIcon aria-hidden />;
  return <HistoryIcon aria-hidden />;
};

/**
 * Home's panel (app-shell.md, "Home"): Overview, Board and All tasks; the member's own live tasks,
 * needs-you ones first, from Home's board query; and the tasks they opened lately in this browser.
 */
export const HomePanel = ({ mode, onNavigate }: { readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const trpc = useTRPC();
  const shell = useShellState();
  const name = shell.me.organization?.name ?? t("shell.noOrganization");
  const needsYou = useQuery(trpc.home.board.queryOptions({ column: "needs-you" }));
  const running = useQuery(trpc.home.board.queryOptions({ column: "running" }));
  const cards = [...(needsYou.data?.columns ?? []), ...(running.data?.columns ?? [])].flatMap((column) => column.cards);
  const live = yoursLive(cards, shell.me.memberId);
  const failed = needsYou.isError || running.isError;
  const loading = needsYou.isPending || running.isPending;

  const recent = shell.recentTasks;

  const row = shell.place.space === "home" ? shell.place.row : null;
  return (
    <PanelFrame mode={mode} label={name} title={<PanelTitle>{name}</PanelTitle>}>
      {homeRows.map((entry) => (
        <NavLink key={entry.id} href={entry.href} icon={<ShellIconView name={entry.icon} />} current={row === entry.id} onNavigate={onNavigate}>
          {t(entry.label)}
        </NavLink>
      ))}

      <SectionLabel {...(loading || failed ? {} : { count: live.length })}>{t("shell.panel.yoursLive")}</SectionLabel>
      {loading ? (
        <LiveSkeleton />
      ) : failed ? (
        <LiveFailed retry={() => { void needsYou.refetch(); void running.refetch(); }} />
      ) : live.length === 0 ? (
        <p className="px-2 py-1 text-sm text-faint">
          {t("shell.panel.nothingYours")}{" "}
          <Link href="/tasks/new" onClick={onNavigate} className="text-teal hover:underline">
            {t("shell.newTask")}
          </Link>
        </p>
      ) : (
        <>
          {live.slice(0, YOURS_SHOWN).map((task) => (
            <LiveTaskRow key={task.taskId} task={task} onNavigate={onNavigate} />
          ))}
          {live.length > YOURS_SHOWN ? (
            <NavLink href="/search?q=by%3Ame" current={false} onNavigate={onNavigate}>
              {t("shell.panel.more", { n: live.length - YOURS_SHOWN })}
            </NavLink>
          ) : null}
        </>
      )}

      {recent.length === 0 ? null : (
        <>
          <SectionLabel>{t("shell.panel.recent")}</SectionLabel>
          {recent.map((task) => (
            <NavLink key={task.taskId} href={`/tasks/${task.taskId}`} icon={<RecentMark state={cards.find((card) => card.taskId === task.taskId)?.state ?? null} />} title={`${task.key} ${task.title}`} onNavigate={onNavigate}>
              <span className="mr-1.5 font-mono text-[12.5px] text-faint">{task.key}</span>
              {task.title}
            </NavLink>
          ))}
        </>
      )}
    </PanelFrame>
  );
};
