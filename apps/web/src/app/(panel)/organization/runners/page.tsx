import { parseServerSettings } from "@ostra/domain";

import { RunnersView } from "@/components/runners/runners-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("runners.title") };

const RunnersPage = async () => {
  const admin = await isAdmin();
  const parsed = parseServerSettings(process.env);
  // Where `ostra runner` reaches core (OSTRA_CORE_PUBLIC_URL); its info names this panel for the device flow.
  const corePublicUrl = parsed.ok ? parsed.settings.corePublicUrl : "http://localhost:8787";
  return <RunnersView corePublicUrl={corePublicUrl} admin={admin} />;
};

export default RunnersPage;
