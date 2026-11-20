import { Suspense } from "react";

import { BoxSizesView } from "@/components/organization/box-sizes-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("boxSizes.title") };

// F-095 (box-sizes.md): every member reads the sizes; only an organization admin changes them.
const BoxSizesPage = () => (
  <Suspense>
    <BoxSizesView />
  </Suspense>
);

export default BoxSizesPage;
