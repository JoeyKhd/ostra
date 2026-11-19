import { notFound } from "next/navigation";

import { taskIdSchema } from "@ostra/protocol";

import { TaskView } from "@/components/tasks/task-view";

const TaskPage = async ({ params }: { readonly params: Promise<{ "task-id": string }> }) => {
  // The route's text is parsed once, here; the page below only holds a `TaskId`.
  const taskId = taskIdSchema.safeParse((await params)["task-id"]);
  if (!taskId.success) notFound();
  return <TaskView taskId={taskId.data} />;
};

export default TaskPage;
