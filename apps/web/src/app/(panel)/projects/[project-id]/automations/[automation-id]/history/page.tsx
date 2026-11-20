import { notFound } from "next/navigation";
import { Suspense } from "react";

import { automationIdSchema, projectIdSchema } from "@ostra/protocol";

import { AutomationHistory } from "@/components/automations/automation-history";
import { t } from "@/lib/messages";

export const metadata = { title: t("automations.history.crumb") };

const AutomationHistoryPage = async ({ params }: { readonly params: Promise<{ "project-id": string; "automation-id": string }> }) => {
  const raw = await params;
  const projectId = projectIdSchema.safeParse(raw["project-id"]);
  const automationId = automationIdSchema.safeParse(raw["automation-id"]);
  if (!projectId.success || !automationId.success) notFound();
  return (
    <Suspense>
      <AutomationHistory projectId={projectId.data} automationId={automationId.data} />
    </Suspense>
  );
};

export default AutomationHistoryPage;
