import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { AutomationEditor } from "@/components/automations/automation-editor";
import { t } from "@/lib/messages";

export const metadata = { title: t("automations.title") };

const NewAutomationPage = async ({ params, searchParams }: { readonly params: Promise<{ "project-id": string }>; readonly searchParams: Promise<{ readonly starts?: string | string[] }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  const starts = (await searchParams).starts === "schedule" ? "schedule" : "match";
  return (
    <Suspense>
      <AutomationEditor projectId={projectId.data} automationId={null} starts={starts} />
    </Suspense>
  );
};

export default NewAutomationPage;
