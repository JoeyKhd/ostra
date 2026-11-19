import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { LinearView } from "@/components/linear/linear-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("linear.title") };

// Admins only, like the GitHub page (ticket 33, "Decided 2026-11-19"): a member gets `AdminOnly`.
const LinearPage = async () =>
  (await isAdmin()) ? (
    <Suspense>
      <LinearView />
    </Suspense>
  ) : (
    <AdminOnly title={t("linear.title")} />
  );

export default LinearPage;
