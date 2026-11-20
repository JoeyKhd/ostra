import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { NeedsApprovalView } from "@/components/approvals/needs-approval-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("approvals.title") };

const NeedsApprovalPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <NeedsApprovalView projectId={projectId.data} organizationAdmin={await isAdmin()} />
    </Suspense>
  );
};

export default NeedsApprovalPage;
