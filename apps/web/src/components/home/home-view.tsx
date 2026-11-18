"use client";

import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import Link from "next/link";

import { PageFrame, PageHeading, Section } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { buttonVariants } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { SetupChecklist } from "./setup-checklist";

const today = (): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date());

/** The organization's Home: the checklist while setup isn't done, then its projects. */
export const HomeView = () => {
  const trpc = useTRPC();
  const me = useQuery(trpc.me.get.queryOptions());
  const projects = useQuery(trpc.projects.list.queryOptions());
  const organization = me.data?.organization;
  const admin = organization?.role === "admin";

  return (
    <PageFrame
      crumbs={[{ label: organization?.name ?? "" }, { label: t("home.title") }]}
      actions={
        <Link href="/tasks/new" className={buttonVariants()}>
          <PlusIcon /> {t("shell.newTask")}
        </Link>
      }
    >
      <PageHeading eyebrow={<span suppressHydrationWarning>{today()}</span>} title={organization?.name ?? t("home.title")} lede={t("home.lede")} />
      <SetupChecklist admin={admin} />
      <Section title={t("home.projects")} count={projects.data?.length ?? 0}>
        {projects.data?.length === 0 ? (
          <p className="border-t border-line py-3 text-muted">{admin ? t("home.noProjectsAdmin") : t("home.noProjects")}</p>
        ) : (
          <ul className="rows">
            {projects.data?.map((project) => (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`} className="flex min-h-10 items-center gap-3 hover:bg-raise">
                  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="hidden font-mono text-sm text-faint md:inline">{project.repos.map((repo) => repo.fullName).join(", ")}</span>
                  {project.needsYouCount > 0 ? <Status tone="amber">{t("home.needsYou", { n: project.needsYouCount })}</Status> : null}
                  <span className="w-20 text-right font-mono text-sm text-muted">{t("home.running", { n: project.runningCount })}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageFrame>
  );
};
