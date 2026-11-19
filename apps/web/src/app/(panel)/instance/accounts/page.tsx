import { parseServerSettings } from "@ostra/domain";
import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { AccountsView } from "@/components/instance/accounts-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("instance.accounts.title") };

/** Instance › Accounts (ticket 33): the instance admin's alone; anyone else gets the instance wording. */
const AccountsPage = async () => {
  const { caller } = await getServerApi();
  const me = await caller.me.get();
  if (!me.instanceAdmin) return <AdminOnly title={t("instance.accounts.title")} scope="instance" />;
  const email = await caller.email.on();
  const parsed = parseServerSettings(process.env);
  return (
    <Suspense>
      <AccountsView emailOn={email.on} hours={parsed.ok ? parsed.settings.resetLinkHours : 24} />
    </Suspense>
  );
};

export default AccountsPage;
