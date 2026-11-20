import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { MemoryPage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.title") };

/** A project's Memory (F-109), for whoever can open the project. */
const ProjectMemoryPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <MemoryPage memoryRef={{ scope: "project", projectId: projectId.data }} />
    </Suspense>
  );
};

export default ProjectMemoryPage;
