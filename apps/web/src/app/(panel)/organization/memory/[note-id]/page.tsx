import { notFound } from "next/navigation";
import { Suspense } from "react";

import { noteIdSchema } from "@ostra/protocol";

import { MemoryNotePage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.title") };

const OrganizationNotePage = async ({ params }: { readonly params: Promise<{ "note-id": string }> }) => {
  const noteId = noteIdSchema.safeParse((await params)["note-id"]);
  if (!noteId.success) notFound();
  return (
    <Suspense>
      <MemoryNotePage memoryRef={{ scope: "organization" }} noteId={noteId.data} />
    </Suspense>
  );
};

export default OrganizationNotePage;
