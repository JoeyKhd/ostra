import { projectIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { ProjectAccessView } from "@/components/projects/project-access-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("access.title") };

/**
 * A project's Access tab (F-087, ticket 33): every member who can open the project reads it; anyone
 * else gets "not found", as the API answers.
 */
const AccessPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const { caller } = await getServerApi();
  await caller.projects.get({ projectId: projectId.data }).catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  return <ProjectAccessView projectId={projectId.data} />;
};

export default AccessPage;
