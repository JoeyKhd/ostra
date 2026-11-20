import { projectIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { notFound, redirect } from "next/navigation";

import { ProjectRunnersView } from "@/components/projects/project-runners-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("projectRunners.title") };

/**
 * A project's Runners tab (F-086, F-095, project-runners.md): its admins and the organization's.
 * A project member is sent to the first tab they may open; anyone else gets "not found".
 */
const RunnersPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const { caller } = await getServerApi();
  const allowed = await caller.fleetUse.project({ projectId: projectId.data }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
      if (error instanceof TRPCError && error.code === "FORBIDDEN") return false;
      throw error;
    },
  );
  if (!allowed) redirect(`/projects/${projectId.data}/settings/models`);
  return <ProjectRunnersView projectId={projectId.data} />;
};

export default RunnersPage;
