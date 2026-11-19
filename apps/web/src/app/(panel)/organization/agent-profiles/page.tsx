import { Suspense } from "react";

import { AgentProfilesView } from "@/components/agent-profiles/agent-profiles-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("agentProfiles.title") };

// Every member sees the profiles they may use; admins see all and edit (F-021, ticket 42).
const AgentProfilesPage = () => (
  <Suspense>
    <AgentProfilesView />
  </Suspense>
);

export default AgentProfilesPage;
