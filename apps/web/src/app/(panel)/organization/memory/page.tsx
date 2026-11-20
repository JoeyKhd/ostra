import { Suspense } from "react";

import { MemoryPage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.title") };

/** The organization's Memory (F-109): every member reads and writes its notes. */
const OrganizationMemoryPage = () => (
  <Suspense>
    <MemoryPage memoryRef={{ scope: "organization" }} />
  </Suspense>
);

export default OrganizationMemoryPage;
