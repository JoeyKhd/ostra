import { AdminOnly } from "@/components/common/admin-only";
import { AgentProfileEditor } from "@/components/agent-profiles/agent-profile-editor";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("agentProfiles.newProfile") };

const NewAgentProfilePage = async () => ((await isAdmin()) ? <AgentProfileEditor profileId={null} /> : <AdminOnly title={t("agentProfiles.title")} />);

export default NewAgentProfilePage;
