import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { InboxView } from "@/components/inbox/inbox-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("inbox.title") };

const InboxPage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      <InboxView projectId={projectId.data} admin={await isAdmin()} />
    </Suspense>
  );
};

export default InboxPage;
