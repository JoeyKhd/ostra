import { projectIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { AuditView } from "@/components/organization/audit-view";
import { ProjectSettingsTabs } from "@/components/projects/settings-tabs";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("audit.title") };

/**
 * A project's audit (F-073, ticket 34): the same log, fixed to the project, for its admins. ADR 0054
 * keeps the export for organization admins.
 */
const ProjectAuditPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const { caller } = await getServerApi();
  const [me, project] = await Promise.all([
    caller.me.get(),
    caller.projects.get({ projectId: projectId.data }).catch((error: unknown) => {
      if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
      throw error;
    }),
  ]);
  if (project.role !== "admin") return <AdminOnly title={t("audit.title")} />;
  return (
    <Suspense>
      <AuditView
        organization={me.organization?.name ?? ""}
        project={{ id: projectId.data, name: project.name }}
        canExport={me.organization?.role === "admin"}
        tabs={<ProjectSettingsTabs projectId={projectId.data} admin />}
      />
    </Suspense>
  );
};

export default ProjectAuditPage;
