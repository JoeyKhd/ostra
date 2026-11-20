import { RunnersView } from "@/components/runners/runners-view";
import { t } from "@/lib/messages";
import { fleetSettings } from "@/server/fleet-settings";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("runners.title") };

const RunnersPage = async () => {
  const admin = await isAdmin();
  // Where `ostra runner` reaches core (OSTRA_CORE_PUBLIC_URL); its info names this panel for the device flow.
  return <RunnersView settings={fleetSettings()} admin={admin} />;
};

export default RunnersPage;
