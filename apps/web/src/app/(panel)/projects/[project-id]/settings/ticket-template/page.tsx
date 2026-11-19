import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema } from "@ostra/protocol";

import { TicketTemplateView } from "@/components/projects/ticket-template-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("ticketTemplate.title") };

const TicketTemplatePage = async ({ params }: { readonly params: Promise<{ "project-id": string }> }) => {
  const projectId = projectIdSchema.safeParse((await params)["project-id"]);
  if (!projectId.success) notFound();
  return (
    <Suspense>
      {/* The Inbox's tickets come with ticket 29's `inbox.list`; until then there is none to preview on. */}
      <TicketTemplateView projectId={projectId.data} tickets={[]} />
    </Suspense>
  );
};

export default TicketTemplatePage;
