import { notFound } from "next/navigation";
import { Suspense } from "react";

import { projectIdSchema, ticketIdSchema } from "@ostra/protocol";

import { TicketParentView } from "@/components/tickets/ticket-parent-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("ticketParent.title") };

const TicketPage = async ({ params }: { readonly params: Promise<{ "project-id": string; "ticket-id": string }> }) => {
  const raw = await params;
  const projectId = projectIdSchema.safeParse(raw["project-id"]);
  const ticketId = ticketIdSchema.safeParse(raw["ticket-id"]);
  if (!projectId.success || !ticketId.success) notFound();
  return (
    <Suspense>
      <TicketParentView projectId={projectId.data} ticketId={ticketId.data} />
    </Suspense>
  );
};

export default TicketPage;
