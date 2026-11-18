import { AdminOnly } from "@/components/common/admin-only";
import { NewProjectView } from "@/components/projects/new-project-view";
import { t } from "@/lib/messages";
import { isAdmin } from "@/server/viewer";

export const metadata = { title: t("projects.newTitle") };

const NewProjectPage = async () => ((await isAdmin()) ? <NewProjectView /> : <AdminOnly title={t("projects.newTitle")} />);

export default NewProjectPage;
