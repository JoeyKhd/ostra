import { notFound, redirect } from "next/navigation";

import { projectIdSchema } from "@ostra/protocol";

/** The repos page lives under Settings (ticket 39, decided 2026-11-19); the old address leads there. */
const ReposPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  redirect(`/projects/${projectId.data}/settings/repos`);
};

export default ReposPage;
