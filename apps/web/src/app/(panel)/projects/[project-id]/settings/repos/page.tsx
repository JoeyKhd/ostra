import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { ProjectReposView } from "@/components/projects/project-repos";
import { t } from "@/lib/messages";
import { getApiDeps } from "@/server/deps";

export const metadata = { title: t("projectRepos.title") };

/** Settings, Repos (F-098, project-repos.md): the project's repos in order; its admins add, reorder and remove them. */
const ProjectReposPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `ProjectId`.
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const { settings } = await getApiDeps();
  return (
    <Suspense>
      <ProjectReposView projectId={projectId.data} maxRepos={settings.projectMaxRepos} />
    </Suspense>
  );
};

export default ProjectReposPage;
