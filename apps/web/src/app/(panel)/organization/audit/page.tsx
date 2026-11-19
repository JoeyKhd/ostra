import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { AuditView } from "@/components/organization/audit-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("audit.title") };

/** Organization › Audit log (F-073, ticket 34): the organization's admins alone. */
const AuditPage = async () => {
  const { caller } = await getServerApi();
  const me = await caller.me.get();
  if (me.organization?.role !== "admin") return <AdminOnly title={t("audit.title")} />;
  return (
    <Suspense>
      <AuditView organization={me.organization.name} canExport />
    </Suspense>
  );
};

export default AuditPage;
