import { Suspense } from "react";

import { SearchView } from "@/components/search/search-view";
import { t } from "@/lib/messages";
import { getServerApi } from "@/server/api";

export const metadata = { title: t("search.title") };

/** Search (F-080, ticket 35): every task the member can open, by what was said or run in it. */
const SearchPage = async () => {
  const { caller } = await getServerApi();
  const me = await caller.me.get();
  return (
    <Suspense>
      <SearchView organization={me.organization?.name ?? ""} />
    </Suspense>
  );
};

export default SearchPage;
