import { TaskView } from "@/components/tasks/task-view";

const TaskPage = async ({ params }: { readonly params: Promise<{ "task-id": string }> }) => {
  const taskId = (await params)["task-id"];
  return <TaskView taskId={taskId} />;
};

export default TaskPage;
