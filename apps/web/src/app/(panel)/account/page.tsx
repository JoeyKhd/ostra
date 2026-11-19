import { Suspense } from "react";

import { AccountView } from "@/components/account/account-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("shell.account") };

const AccountPage = () => (
  <Suspense>
    <AccountView />
  </Suspense>
);

export default AccountPage;
