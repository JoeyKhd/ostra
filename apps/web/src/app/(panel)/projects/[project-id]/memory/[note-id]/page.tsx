import { notFound } from "next/navigation";
import { Suspense } from "react";

import { noteIdSchema, projectIdSchema } from "@ostra/protocol";

import { MemoryNotePage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.title") };

const ProjectNotePage = async ({ params }: { readonly params: Promise<{ "project-id": string; "note-id": string }> }) => {
  const raw = await params;
  const projectId = projectIdSchema.safeParse(raw["project-id"]);
  const noteId = noteIdSchema.safeParse(raw["note-id"]);
  if (!projectId.success || !noteId.success) notFound();
  return (
    <Suspense>
      <MemoryNotePage memoryRef={{ scope: "project", projectId: projectId.data }} noteId={noteId.data} />
    </Suspense>
  );
};

export default ProjectNotePage;
