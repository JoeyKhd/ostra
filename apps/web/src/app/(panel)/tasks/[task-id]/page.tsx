import { notFound } from "next/navigation";
import { Suspense } from "react";

import { taskIdSchema } from "@ostra/protocol";

import { TaskView } from "@/components/tasks/task-view";

const TaskPage = async ({ params }: { readonly params: Promise<{ "task-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `TaskId`.
  const taskId = taskIdSchema.safeParse((await params)["task-id"]);
  if (!taskId.success) notFound();
  // The tabs read `?tab=` (ticket 46), so the page waits for the search params.
  return (
    <Suspense>
      <TaskView taskId={taskId.data} />
    </Suspense>
  );
};

export default TaskPage;
