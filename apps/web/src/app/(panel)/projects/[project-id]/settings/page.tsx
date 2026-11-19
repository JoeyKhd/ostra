import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";

import { projectIdSchema } from "@ostra/protocol";

import { getServerApi } from "@/server/api";

// A project's settings open on the first tab the member may use: the ticket template for its
// admins (ticket-template.md), Access, read-only, for its members (project-access.md).
const SettingsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const { caller } = await getServerApi();
  const project = await caller.projects.get({ projectId: projectId.data }).catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  redirect(`/projects/${projectId.data}/settings/${project.role === "admin" ? "ticket-template" : "access"}`);
};

export default SettingsPage;
