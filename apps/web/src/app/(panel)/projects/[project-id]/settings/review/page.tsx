import { projectIdSchema } from "@ostra/protocol";
import { notFound } from "next/navigation";

import { ReviewSettingsView } from "@/components/projects/review-settings-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("reviewSettings.title") };

/** A project's Review settings (F-100, F-101, ticket 35): any member who can open the project reads them. */
const ReviewSettingsPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return <ReviewSettingsView projectId={projectId.data} />;
};

export default ReviewSettingsPage;
