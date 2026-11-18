import { ProjectView } from "@/components/projects/project-view";

const ProjectPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = (await params)["project-id"];
  return <ProjectView projectId={projectId} />;
};

export default ProjectPage;
