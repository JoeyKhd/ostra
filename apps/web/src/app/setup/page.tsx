import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/auth-card";
import { FirstAdminForm } from "@/components/auth/first-admin-form";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("firstAdmin.title") };

/** "Create the first admin": shown only while no account exists (F-001, F-002). */
const SetupPage = async () => {
  const { caller, signedIn } = await getServerApi();
  const state = await caller.setup.state();
  if (!state.needsFirstAdmin) redirect(signedIn ? "/" : "/sign-in");
  return (
    <AuthCard title={t("firstAdmin.title")} lede={t("firstAdmin.lede")}>
      <FirstAdminForm />
    </AuthCard>
  );
};

export default SetupPage;
