import { notFound, redirect } from "next/navigation";

import { projectIdSchema } from "@ostra/protocol";

// A project's settings hold only its ticket template in milestone 2 (ticket-template.md).
const SettingsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  redirect(`/projects/${projectId.data}/settings/ticket-template`);
};

export default SettingsPage;
