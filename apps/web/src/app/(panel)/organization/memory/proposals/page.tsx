import { Suspense } from "react";

import { MemoryProposalsPage } from "@/components/memory/memory-pages";
import { t } from "@/lib/messages";

export const metadata = { title: t("memory.proposalsList.title") };

const OrganizationProposalsPage = () => (
  <Suspense>
    <MemoryProposalsPage memoryRef={{ scope: "organization" }} />
  </Suspense>
);

export default OrganizationProposalsPage;
