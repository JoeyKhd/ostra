import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { PreviewsView } from "@/components/instance/previews-view";
import { t } from "@/lib/messages";
import { isInstanceAdmin } from "@/server/viewer";

export const metadata = { title: t("instance.previews.title") };

/**
 * Instance › Previews (milestone 8, ticket 26, F-144; instance-preview-domain.md): the preview domain,
 * its record, certificate and check, and public links. The instance admin's alone; anyone else gets
 * the instance wording.
 */
const PreviewsPage = async () =>
  (await isInstanceAdmin()) ? (
    <Suspense>
      <PreviewsView />
    </Suspense>
  ) : (
    <AdminOnly title={t("instance.previews.title")} scope="instance" />
  );

export default PreviewsPage;
