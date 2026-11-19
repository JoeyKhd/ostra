import { parseServerSettings } from "@ostra/domain";

import { MembersView } from "@/components/members/members-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("members.title") };

/** Organization › Members (ticket 32): every member sees the list; admins act on it. */
const MembersPage = async () => {
  const { caller } = await getServerApi();
  const [me, email] = await Promise.all([caller.me.get(), caller.email.status()]);
  const parsed = parseServerSettings(process.env);
  return <MembersView admin={me.organization?.role === "admin"} emailOn={email.on} invitationDays={parsed.ok ? parsed.settings.invitationDays : 7} />;
};

export default MembersPage;
