import { Suspense } from "react";

import { AdminOnly } from "@/components/common/admin-only";
import { GitHubView } from "@/components/github/github-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("github.title") };

const GitHubPage = async () =>
  (await isAdmin()) ? (
    <Suspense>
      <GitHubView />
    </Suspense>
  ) : (
    <AdminOnly title={t("github.title")} />
  );

export default GitHubPage;
