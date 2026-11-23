import { notFound } from "next/navigation";
import { Suspense } from "react";

import { connectionIdSchema } from "@ostra/protocol";

import { ConnectionPage } from "@/components/trackers/connection-page";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("trackers.title") };

// A tracker connection's page (F-152, choice 13). Tickets 13 (Jira's connect steps) and 14 (each
// connection's settings) build it to its targets; until then it holds Linear's page per connection
// and every connection's detail.
const TrackerConnectionPage = async ({ params }: { readonly params: Promise<{ "connection-id": string }> }) => {
  const connectionId = connectionIdSchema.safeParse((await params)["connection-id"]);
  if (!connectionId.success) notFound();
  const admin = await isAdmin();
  return (
    <Suspense>
      <ConnectionPage connectionId={connectionId.data} admin={admin} />
    </Suspense>
  );
};

export default TrackerConnectionPage;
