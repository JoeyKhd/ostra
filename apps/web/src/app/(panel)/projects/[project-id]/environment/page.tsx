import { Suspense } from "react";

import { EnvironmentView } from "@/components/projects/environment-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("environment.title") };

const EnvironmentPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = (await params)["project-id"];
  return (
    <Suspense>
      <EnvironmentView projectId={projectId} />
    </Suspense>
  );
};

export default EnvironmentPage;
