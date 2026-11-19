import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { RepoChecksView } from "@/components/projects/repo-checks";
import { t } from "@/lib/messages";

export const metadata = { title: t("repos.title") };

const ReposPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `ProjectId`.
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <RepoChecksView projectId={projectId.data} />
    </Suspense>
  );
};

export default ReposPage;
