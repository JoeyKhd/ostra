"use client";

import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { buttonVariants } from "@/components/ui/button";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { homeHref, viewOf } from "./board-words";
import { HomeToolbar } from "./home-board";
import { HomeBoardView } from "./home-board-view";
import { HomePanel } from "./home-panel";
import { ActivitySection, NeedsYouSection, ProjectsSection } from "./home-sections";
import type { Load } from "./home-sections";
import { summaryText } from "./home-words";
import { SetupChecklist } from "./setup-checklist";
import { FirstRunIllustration } from "./setup-steps";

type Overview = RouterOutputs["home"]["overview"];

const today = (now: Date): string => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(now);

/** Home refreshes its counts and ages every half minute while it's open. */
const REFRESH_MS = 30_000;

/**
 * The organization's Home (home.md, F-062): Needs you, Projects and Recent activity, with PRs,
 * spend and runners in the right panel. While setup isn't done (F-076), the checklist takes Needs
 * you's place and the panel gives way to the Deep water picture (home-first-run.md).
 */
export const HomeView = () => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const setup = useQuery(trpc.setup.status.queryOptions());
  const overview = useQuery({ ...trpc.home.overview.queryOptions(), refetchInterval: REFRESH_MS });
  const [now] = useState(() => new Date());
  const router = useRouter();
  const params = useSearchParams();
  const view = viewOf(params);
  const project = params.get("project");
  const projects = (overview.data?.projects.rows ?? []).map((row) => ({ id: row.id, name: row.name }));
  const organization = me.data?.organization;
  const admin = organization?.role === "admin";
  const setupDone = setup.data?.next === null;
  const firstRun = setup.data !== undefined && setup.data.next !== null;

  const load = <T,>(pick: (data: Overview) => T): Load<T> =>
    overview.data !== undefined
      ? { kind: "ready", data: pick(overview.data) }
      : overview.isError
        ? { kind: "error", retry: () => void overview.refetch() }
        : { kind: "loading" };
  const at = overview.dataUpdatedAt === 0 ? now.getTime() : overview.dataUpdatedAt;
  const lede = overview.data === undefined || overview.data.summary.projects === 0 ? t("home.lede") : summaryText(overview.data.summary);

  return (
    <PageFrame
      crumbs={[{ label: organization?.name ?? "" }, { label: t("home.title") }]}
      actions={
        // Until setup is done, the checklist's next step is the page's one primary button.
        <Link href="/tasks/new" className={buttonVariants({ variant: setupDone ? "primary" : "outline" })}>
          <PlusIcon /> {t("shell.newTask")}
        </Link>
      }
      {...(setupDone
        ? { properties: <HomePanel overview={overview.data} now={now} /> }
        : firstRun
          ? { properties: <FirstRunIllustration />, decorative: true }
          : {})}
    >
      <PageHeading eyebrow={<span suppressHydrationWarning>{today(now)}</span>} title={organization?.name ?? t("home.title")} lede={lede} />
      {firstRun ? null : (
        <HomeToolbar
          view={view}
          onView={(next) => { router.replace(homeHref(next, project)); }}
          projects={projects}
          project={project}
          onProject={(next) => { router.replace(homeHref("board", next)); }}
        />
      )}
      {view === "board" && !firstRun ? (
        <div className="mt-4">
          <HomeBoardView projectId={project} projectName={projects.find((one) => one.id === project)?.name ?? null} now={at} />
        </div>
      ) : (
        <>
          {firstRun ? <SetupChecklist admin={admin} /> : <NeedsYouSection load={load((data) => data.needsYou)} now={at} />}
          <ProjectsSection load={load((data) => data.projects)} admin={admin} now={now} />
          <ActivitySection load={load((data) => data.activity)} now={at} />
        </>
      )}
    </PageFrame>
  );
};
