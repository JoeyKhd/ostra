import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { RegistryView } from "@/components/organization/registry-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("registryPage.title") };

// F-120 (registry.md): the organization's snapshot registry, for its admins.
const RegistryPage = async () =>
  (await isAdmin()) ? (
    <Suspense>
      <RegistryView />
    </Suspense>
  ) : (
    <AdminOnly title={t("registryPage.title")} />
  );

export default RegistryPage;
