import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { AutomationsView } from "@/components/automations/automations-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("automations.title") };

const AutomationsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <AutomationsView projectId={projectId.data} />
    </Suspense>
  );
};

export default AutomationsPage;
