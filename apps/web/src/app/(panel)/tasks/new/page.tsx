import { NewTaskView } from "@/components/tasks/new-task-view";
import { t } from "@/lib/messages";

export const metadata = { title: t("newTask.title") };

const NewTaskPage = () => <NewTaskView />;

export default NewTaskPage;
