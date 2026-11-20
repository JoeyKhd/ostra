import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { MemoryProposalsPage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.proposalsList.title") };

const ProjectProposalsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <MemoryProposalsPage memoryRef={{ scope: "project", projectId: projectId.data }} />
    </Suspense>
  );
};

export default ProjectProposalsPage;
