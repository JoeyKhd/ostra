import { Suspense } from "react";

import { NewTaskView } from "@/components/tasks/new-task-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("newTask.title") };

// The view reads `?kind=` and `?project=` (ticket 34), so the page waits for the search params.
const NewTaskPage = () => (
  <Suspense>
    <NewTaskView />
  </Suspense>
);

export default NewTaskPage;
