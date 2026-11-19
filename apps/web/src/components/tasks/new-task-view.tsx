"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { fieldClass } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { NewTaskForm } from "./new-task-form";

/** "New task" from anywhere: pick the project, then the prompt and "Run on" (F-097). */
export const NewTaskView = () => {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const projectId = picked ?? projects.data?.[0]?.id ?? null;
  return (
    <PageFrame crumbs={[{ label: t("newTask.title") }]}>
      <PageHeading title={t("newTask.title")} lede={t("newTask.lede")} />
      {projects.data?.length === 0 ? (
        <div className="mt-6">
          <p className="mb-3 text-muted">{t("newTask.noProject")}</p>
          <Link href="/projects/new" className={buttonVariants({ variant: "primary" })}>{t("checklist.project.action")}</Link>
        </div>
      ) : (
        <div className="mt-6 max-w-[720px]">
          <Field id="task-project" label={t("newTask.project")}>
            <select id="task-project" className={cn(fieldClass, "h-8 w-auto")} value={projectId ?? ""} onChange={(e) => { setPicked(projects.data?.find((project) => project.id === e.target.value)?.id ?? null); }}>
              {projects.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </Field>
          {projectId === null ? null : <NewTaskForm key={projectId} projectId={projectId} />}
        </div>
      )}
    </PageFrame>
  );
};
