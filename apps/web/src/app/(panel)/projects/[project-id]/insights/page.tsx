import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { InsightsView } from "@/components/insights/insights-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("insights.title") };

/** A project's Insights (F-108), for the members who can open the project. */
const ProjectInsightsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `ProjectId`.
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <InsightsView scope="project" projectId={projectId.data} admin={await isAdmin()} />
    </Suspense>
  );
};

export default ProjectInsightsPage;
