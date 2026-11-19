import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { StorageView } from "@/components/organization/storage-view";
import { t } from "@/lib/messages";
import { isInstanceAdmin } from "@/server/viewer";

export const metadata = { title: t("storage.title") };

// Instance admins only (ticket 37, "Decided 2026-11-19"): the store and retention are the install's.
const StoragePage = async () =>
  (await isInstanceAdmin()) ? (
    <Suspense>
      <StorageView />
    </Suspense>
  ) : (
    <AdminOnly title={t("storage.title")} scope="instance" />
  );

export default StoragePage;
