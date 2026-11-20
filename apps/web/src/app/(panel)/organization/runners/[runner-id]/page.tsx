import { notFound } from "next/navigation";

import { runnerIdSchema } from "@ostra/protocol";

import { RunnerView } from "@/components/runners/runner-view";
import { t } from "@/lib/messages";
import { fleetSettings } from "@/server/fleet-settings";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("runner.metaTitle") };

/** A runner's page (ticket 31, runner.md): an admin's view of any runner, a member's of their own. */
const RunnerPage = async ({ params }: { readonly params: Promise<{ "runner-id": string }> }) => {
  const runnerId = runnerIdSchema.safeParse((await params)["runner-id"]);
  if (!runnerId.success) notFound();
  return <RunnerView key={runnerId.data} runnerId={runnerId.data} admin={await isAdmin()} serverVersion={fleetSettings().serverVersion} />;
};

export default RunnerPage;
