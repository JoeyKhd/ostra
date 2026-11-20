import { notFound } from "next/navigation";
import { Suspense } from "react";

import { automationIdSchema, projectIdSchema } from "@ostra/protocol";

import { AutomationEditor } from "@/components/automations/automation-editor";
import { t } from "@/lib/messages";

export const metadata = { title: t("automations.title") };

const AutomationPage = async ({ params }: { readonly params: Promise<{ "project-id": string; "automation-id": string }> }) => {
  const raw = await params;
  const projectId = projectIdSchema.safeParse(raw["project-id"]);
  const automationId = automationIdSchema.safeParse(raw["automation-id"]);
  if (!projectId.success || !automationId.success) notFound();
  return (
    <Suspense>
      <AutomationEditor projectId={projectId.data} automationId={automationId.data} starts="match" />
    </Suspense>
  );
};

export default AutomationPage;
