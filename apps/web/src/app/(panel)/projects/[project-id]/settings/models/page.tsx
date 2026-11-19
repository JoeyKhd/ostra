import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { ProjectModelsView } from "@/components/projects/project-models-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("projectModels.title") };

// A project's settings › Models and keys (F-135): everyone who can open the project reads it;
// only an organization admin changes it, which the API enforces.
const ProjectModelsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <ProjectModelsView projectId={projectId.data} />
    </Suspense>
  );
};

export default ProjectModelsPage;
