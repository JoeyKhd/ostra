import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { EnvironmentView } from "@/components/projects/environment-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("environment.title") };

const EnvironmentPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `ProjectId`.
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <EnvironmentView projectId={projectId.data} />
    </Suspense>
  );
};

export default EnvironmentPage;
