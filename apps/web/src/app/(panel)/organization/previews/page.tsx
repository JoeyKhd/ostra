import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { OrganizationPreviewsView } from "@/components/organization/organization-previews-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("organizationPreviews.title") };

/**
 * Organization › Previews (milestone 8, F-142): the organization's public preview links, for its
 * admins alone, whether or not they're the instance admin. Anyone else gets the admins' wording.
 */
const OrganizationPreviewsPage = async () =>
  (await isAdmin()) ? (
    <Suspense>
      <OrganizationPreviewsView />
    </Suspense>
  ) : (
    <AdminOnly title={t("organizationPreviews.title")} />
  );

export default OrganizationPreviewsPage;
