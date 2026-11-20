import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { MemoryNotePage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.note.newTitle") };

const NewProjectNotePage = async ({ params, searchParams }: { readonly params: Promise<{ "project-id": string }>; readonly searchParams: Promise<{ readonly scope?: string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const scope = (await searchParams).scope === "organization" ? "organization" : "project";
  return (
    <Suspense>
      <MemoryNotePage memoryRef={{ scope: "project", projectId: projectId.data }} noteId={null} startScope={scope} />
    </Suspense>
  );
};

export default NewProjectNotePage;
