import { notFound } from "next/navigation";

import { agentProfileIdSchema } from "@ostra/protocol";

import { AgentProfileEditor } from "@/components/agent-profiles/agent-profile-editor";
import { t } from "@/lib/messages";

export const metadata = { title: t("agentProfiles.title") };

const AgentProfilePage = async ({ params }: { readonly params: Promise<{ "profile-id": string }> }) => {
  const profileId = agentProfileIdSchema.safeParse((await params)["profile-id"]);
  if (!profileId.success) notFound();
  return <AgentProfileEditor key={profileId.data} profileId={profileId.data} />;
};

export default AgentProfilePage;
