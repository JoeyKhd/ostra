import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { SpendView } from "@/components/spend/spend-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";
import { getApiDeps } from "@/server/deps";

export const metadata = { title: t("spend.title") };

/** Organization, Spend (F-037): organization admins only, who set the budgets and the prices. */
const SpendPage = async () => {
  const { caller, signedIn } = await getServerApi();
  const me = signedIn ? await caller.me.get() : null;
  if (me?.organization?.role !== "admin") return <AdminOnly title={t("spend.title")} />;
  const { settings } = await getApiDeps();
  return (
    <Suspense>
      <SpendView organizationName={me.organization.name} warnPercent={settings.budgetWarnPercent} />
    </Suspense>
  );
};

export default SpendPage;
