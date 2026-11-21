import { Suspense } from "react";

import { LibraryPage } from "@/components/library/library-page";
import { t } from "@/lib/messages";

export const metadata = { title: t("library.title") };

const SkillsPage = () => (
  <Suspense>
    <LibraryPage />
  </Suspense>
);

export default SkillsPage;
