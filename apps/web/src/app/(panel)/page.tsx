import { Suspense } from "react";

import { HomeView } from "@/components/home/home-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("home.title") };

// Home reads `?view=board` and `?project=` (ticket 44), so it waits for the search params.
const HomePage = () => (
  <Suspense>
    <HomeView />
  </Suspense>
);

export default HomePage;
