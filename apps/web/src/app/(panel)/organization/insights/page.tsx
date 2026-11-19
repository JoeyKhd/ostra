import { Suspense } from "react";

import { InsightsView } from "@/components/insights/insights-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("insights.title") };

/** Organization, Insights (F-108): for every member; projects they can't open fold into "Other projects". */
const OrganizationInsightsPage = async () => {
  const { caller, signedIn } = await getServerApi();
  const me = signedIn ? await caller.me.get() : null;
  return (
    <Suspense>
      <InsightsView scope="organization" organizationName={me?.organization?.name ?? t("shell.noOrganization")} admin={me?.organization?.role === "admin"} />
    </Suspense>
  );
};

export default OrganizationInsightsPage;
