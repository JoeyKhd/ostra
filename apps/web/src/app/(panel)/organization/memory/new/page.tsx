import { Suspense } from "react";

import { MemoryNotePage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.note.newTitle") };

const NewOrganizationNotePage = () => (
  <Suspense>
    <MemoryNotePage memoryRef={{ scope: "organization" }} noteId={null} />
  </Suspense>
);

export default NewOrganizationNotePage;
