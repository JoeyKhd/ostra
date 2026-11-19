import { notFound } from "next/navigation";

import { projectIdSchema } from "@ostra/protocol";

import { ProjectView } from "@/components/projects/project-view";

const ProjectPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `ProjectId`.
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return <ProjectView projectId={projectId.data} />;
};

export default ProjectPage;
