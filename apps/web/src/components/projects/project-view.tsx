"use client";

import { useQuery } from "@tanstack/react-query";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { ProjectProperties } from "./project-properties";

/** A project's page: its heading and properties. Its tasks list is ticket 38's (tasks router, ticket 33). */
export const ProjectView = ({ projectId }: { readonly projectId: string }) => {
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  return (
    <PageFrame
      crumbs={[{ label: t("shell.projects") }, { label: project.data?.name ?? "" }]}
      properties={project.data === undefined ? undefined : <ProjectProperties project={project.data} />}
    >
      {project.error === null ? null : <p role="alert" className="text-red">{errorText(project.error)}</p>}
      {project.data === undefined ? null : (
        <PageHeading title={project.data.name} lede={project.data.repos.map((repo) => repo.fullName).join(", ")} />
      )}
    </PageFrame>
  );
};
