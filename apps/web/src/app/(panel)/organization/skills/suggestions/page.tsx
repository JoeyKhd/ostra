import { Suspense } from "react";

import { SuggestionsPage } from "@/components/library/suggestions-page";
import { t } from "@/lib/messages";

export const metadata = { title: t("library.suggestions.title") };

const LibrarySuggestionsPage = () => (
  <Suspense>
    <SuggestionsPage />
  </Suspense>
);

export default LibrarySuggestionsPage;
